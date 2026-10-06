import {
  type AgentRunInput,
  type AgentStore,
  type AgentStreamEvent,
  type Decision,
  type ElicitationReply,
  type ElicitationRequest,
  type HumanReply,
  type MessageUsage,
  type SinkWriter,
  type ToolCallRequest,
  type ToolResult,
  encodeStreamEvent,
  settleElicitation,
} from '@dudousxd/nestjs-agent-core';
import type { Logger } from '@nestjs/common';
import type {
  OpenCodeClient,
  OpenCodeEvent,
  OpenCodeForm,
  OpenCodePermissionRequest,
} from './client.js';
import { toElicitation, toFormAnswer } from './forms.js';

/** How an OpenCode execution ended. */
export type TurnOutcome =
  | { status: 'succeeded' }
  | { status: 'failed'; error: string }
  | { status: 'interrupted' };

export interface OpenCodeTurnArgs {
  runId: string;
  input: AgentRunInput;
  client: OpenCodeClient;
  sessionId: string;
  writer: SinkWriter;
  store: AgentStore;
  /** Parks until a person decides `toolCallId` (rejects when the run is cancelled). */
  waitForHuman: (toolCallId: string) => Promise<HumanReply>;
  /** Who approves an action (`approval-requested.approver`). */
  approver: string;
  /** The model label usage is recorded under when OpenCode reports none. */
  modelLabel: string;
  logger: Logger;
}

const ASK_TOOL_NAME = 'ask';
const FAILED_STATUSES = new Set(['error', 'failed', 'denied', 'cancelled']);

interface ToolState {
  name: string;
  announced: boolean;
  available: boolean;
  settled: boolean;
  input: Record<string, unknown>;
  /** Code-mode inner calls already announced / settled, by index. */
  innerAnnounced: Set<number>;
  innerSettled: Set<number>;
}

/** One message's worth of the turn, persisted when a person is asked something and at the end. */
interface Segment {
  text: string;
  reasoning: string;
  reasoningMs: number;
  calls: ToolCallRequest[];
  results: ToolResult[];
}

function emptySegment(): Segment {
  return { text: '', reasoning: '', reasoningMs: 0, calls: [], results: [] };
}

function isDecision(reply: HumanReply): reply is Decision {
  return typeof (reply as Decision).approved === 'boolean';
}

function errorText(error: unknown, fallback: string): string {
  if (typeof error === 'string' && error.length > 0) return error;
  const message = (error as { message?: unknown } | undefined)?.message;
  return typeof message === 'string' && message.length > 0 ? message : fallback;
}

/**
 * One turn of an OpenCode session, as the library's stream and store see it. Fed the session's
 * events in order; writes the protocol's frames (`docs/stream-protocol.md`) and persists what the
 * loop would have: the assistant messages with their tool calls and results, the calls put to a
 * person (so the approve/answer routes find their run), usage per model step.
 *
 * - OpenCode's own tools (code-mode `execute`, web search, skills…) are `read` calls; the company
 *   tools a code-mode run calls are nested under it (`parentId`).
 * - `permission.asked` (an `ask` rule) becomes an `action` call parked on a person; `form.created`
 *   (the question tool) an `elicitation`. The run's decision goes back to OpenCode as the
 *   permission reply / form reply.
 * - Every OpenCode step is a `step-start` … `step-finish` pair with that step's usage.
 */
export class OpenCodeTurn {
  readonly done: Promise<TurnOutcome>;
  private finish!: (outcome: TurnOutcome) => void;
  /** Serializes the handling of events, so frames and rows land in the order OpenCode sent them. */
  private chain: Promise<void> = Promise.resolve();
  private segment = emptySegment();
  private readonly tools = new Map<string, ToolState>();
  /** Results already persisted per message, so a late settlement adds to them rather than replacing. */
  private readonly messageResults = new Map<string, ToolResult[]>();
  private readonly asked = new Set<string>();
  private stepOpen = false;
  private sawText = false;
  private separator = false;
  private reasoningSince: number | undefined;
  private wroteMessage = false;
  private ended = false;
  private stepError: string | undefined;

  constructor(private readonly a: OpenCodeTurnArgs) {
    this.done = new Promise((resolve) => {
      this.finish = resolve;
    });
  }

  /** Feed one of the session's events. */
  handle(event: OpenCodeEvent): void {
    this.enqueue(() => this.onEvent(event));
  }

  /** End the turn as failed without an event (the prompt was refused, the stream is gone). */
  fail(error: string): void {
    this.enqueue(() => this.end({ status: 'failed', error }));
  }

  private enqueue(work: () => Promise<void>): void {
    this.chain = this.chain.then(work).catch((error: unknown) => {
      this.a.logger.error(`run ${this.a.runId}: ${errorText(error, 'event handling failed')}`);
      // A turn whose bookkeeping broke can't be trusted to finish on its own.
      if (!this.ended) {
        this.ended = true;
        this.finish({ status: 'failed', error: errorText(error, 'event handling failed') });
      }
    });
  }

  private async write(event: AgentStreamEvent): Promise<void> {
    await this.a.writer.write(encodeStreamEvent(event));
  }

  private async step(): Promise<void> {
    if (this.stepOpen) return;
    this.stepOpen = true;
    await this.write({ kind: 'step-start' });
  }

  private endReasoning(): void {
    if (this.reasoningSince === undefined) return;
    this.segment.reasoningMs += Date.now() - this.reasoningSince;
    this.reasoningSince = undefined;
  }

  private tool(id: string, name = 'tool'): ToolState {
    let state = this.tools.get(id);
    if (state === undefined) {
      state = {
        name,
        announced: false,
        available: false,
        settled: false,
        input: {},
        innerAnnounced: new Set(),
        innerSettled: new Set(),
      };
      this.tools.set(id, state);
      this.segment.calls.push({ id, name, input: state.input, kind: 'read' });
    }
    return state;
  }

  private async announce(id: string, name: string): Promise<ToolState> {
    const state = this.tool(id, name);
    if (!state.announced) {
      state.announced = true;
      await this.write({ kind: 'tool-input-start', id, name: state.name, toolKind: 'read' });
    }
    return state;
  }

  private async makeAvailable(id: string): Promise<ToolState> {
    const state = await this.announce(id, this.tools.get(id)?.name ?? 'tool');
    if (!state.available) {
      state.available = true;
      await this.write({
        kind: 'tool-input-available',
        id,
        name: state.name,
        input: state.input,
        toolKind: 'read',
      });
    }
    return state;
  }

  private setInput(id: string, input: unknown, name?: string): void {
    const state = this.tool(id, name);
    if (input === null || typeof input !== 'object') return;
    Object.assign(state.input, input as Record<string, unknown>);
  }

  private async innerCalls(parentId: string, raw: unknown): Promise<void> {
    if (!Array.isArray(raw)) return;
    const parent = this.tool(parentId);
    for (const [index, call] of raw.entries()) {
      const id = `${parentId}.${index}`;
      const name = String(call?.tool ?? 'tool');
      const input =
        call?.input !== null && typeof call?.input === 'object'
          ? (call.input as Record<string, unknown>)
          : {};
      if (!parent.innerAnnounced.has(index)) {
        parent.innerAnnounced.add(index);
        this.segment.calls.push({ id, name, input, kind: 'read', parentId });
        await this.write({
          kind: 'tool-input-available',
          id,
          name,
          input,
          toolKind: 'read',
          parentId,
        });
      }
      const status = String(call?.status ?? '').toLowerCase();
      if (
        parent.innerSettled.has(index) ||
        status === 'running' ||
        status === 'pending' ||
        !status
      ) {
        continue;
      }
      parent.innerSettled.add(index);
      if (FAILED_STATUSES.has(status)) {
        this.segment.results.push({ id, name, output: { status }, error: status });
        await this.write({ kind: 'tool-output-error', id, error: status });
      } else {
        this.segment.results.push({ id, name, output: { status } });
        await this.write({ kind: 'tool-output', id, output: { status } });
      }
    }
  }

  private async onEvent(e: OpenCodeEvent): Promise<void> {
    if (this.ended) return;
    const d = e.data ?? {};
    switch (e.type) {
      case 'session.text.delta': {
        const delta = typeof d.delta === 'string' ? d.delta : '';
        if (!delta) return;
        this.endReasoning();
        // Whitespace before anything was said is noise.
        if (!this.sawText && !delta.trim()) return;
        await this.step();
        const text = this.separator && this.sawText ? `\n\n${delta}` : delta;
        this.separator = false;
        this.sawText = true;
        this.segment.text += text;
        await this.write({ kind: 'text', text });
        return;
      }
      case 'session.text.ended':
        // The next step's text starts a new paragraph.
        this.separator = true;
        return;
      case 'session.reasoning.delta': {
        const delta = typeof d.delta === 'string' ? d.delta : '';
        if (!delta) return;
        this.reasoningSince ??= Date.now();
        await this.step();
        this.segment.reasoning += delta;
        await this.write({ kind: 'reasoning', text: delta });
        return;
      }
      case 'session.tool.input.started':
        this.endReasoning();
        await this.step();
        await this.announce(String(d.id), String(d.name ?? 'tool'));
        return;
      case 'session.tool.called':
        await this.step();
        this.setInput(String(d.id), d.input, typeof d.name === 'string' ? d.name : undefined);
        await this.makeAvailable(String(d.id));
        return;
      case 'session.skill.activated': {
        const name = String(d.id ?? d.name ?? 'skill');
        const id = `skill:${name}:${this.tools.size}`;
        await this.step();
        await this.announce(id, 'skill');
        this.setInput(id, { name });
        await this.makeAvailable(id);
        await this.settleTool(id, true);
        return;
      }
      case 'session.tool.progress':
        await this.step();
        await this.makeAvailable(String(d.id));
        await this.innerCalls(String(d.id), d.metadata?.toolCalls);
        return;
      case 'session.tool.success':
      case 'session.tool.failed': {
        const id = String(d.id);
        await this.step();
        await this.makeAvailable(id);
        await this.innerCalls(id, d.metadata?.toolCalls);
        await this.settleTool(
          id,
          e.type === 'session.tool.success',
          errorText(d.error, 'tool failed'),
        );
        return;
      }
      case 'session.step.ended':
        this.endReasoning();
        await this.stepEnded(d);
        return;
      case 'session.step.failed':
        this.stepError = errorText(d.error, 'the model call failed');
        return;
      case 'session.renamed':
        if (typeof d.title === 'string' && d.title.trim()) {
          await this.a.store.setTitle(this.a.input.threadId, d.title.trim());
          await this.write({ kind: 'title', title: d.title.trim() });
        }
        return;
      case 'permission.asked':
        await this.onPermission(d as OpenCodePermissionRequest);
        return;
      case 'form.created':
        await this.onForm((d.form ?? d) as OpenCodeForm);
        return;
      case 'session.execution.succeeded':
        await this.end({ status: 'succeeded' });
        return;
      case 'session.execution.failed':
        await this.end({
          status: 'failed',
          error: errorText(d.error, this.stepError ?? 'the execution failed'),
        });
        return;
      case 'session.execution.interrupted':
        await this.end({ status: 'interrupted' });
        return;
      default:
        return;
    }
  }

  private async settleTool(id: string, ok: boolean, error = 'failed'): Promise<void> {
    const state = this.tool(id);
    if (state.settled) return;
    state.settled = true;
    if (ok) {
      this.segment.results.push({ id, name: state.name, output: { ok: true } });
      await this.write({ kind: 'tool-output', id, output: { ok: true } });
    } else {
      this.segment.results.push({ id, name: state.name, output: { ok: false }, error });
      await this.write({ kind: 'tool-output-error', id, error });
    }
  }

  private async stepEnded(d: Record<string, any>): Promise<void> {
    const usage: MessageUsage = {
      inputTokens: Number(d.tokens?.input) || 0,
      outputTokens: Number(d.tokens?.output) || 0,
      ...(Number(d.tokens?.cache?.read) ? { cacheReadTokens: Number(d.tokens.cache.read) } : {}),
      ...(Number(d.tokens?.cache?.write) ? { cacheWriteTokens: Number(d.tokens.cache.write) } : {}),
    };
    const costUsd = typeof d.cost === 'number' ? d.cost : undefined;
    this.usage.inputTokens += usage.inputTokens;
    this.usage.outputTokens += usage.outputTokens;
    if (costUsd !== undefined) this.costUsd = (this.costUsd ?? 0) + costUsd;
    await this.a.store.recordUsage({
      threadId: this.a.input.threadId,
      actorRef: this.a.input.actor.id,
      modelId: this.a.modelLabel,
      purpose: 'chat',
      usage,
      ...(costUsd !== undefined ? { costUsd } : {}),
    });
    if (!this.stepOpen) return;
    this.stepOpen = false;
    await this.write({
      kind: 'step-finish',
      usage,
      costUsd: costUsd ?? null,
      ...(this.segment.reasoningMs > 0 ? { reasoningMs: this.segment.reasoningMs } : {}),
      model: this.a.modelLabel,
    });
  }

  private readonly usage: MessageUsage = { inputTokens: 0, outputTokens: 0 };
  private costUsd: number | undefined;

  /**
   * Persist what the turn produced since the last flush as one assistant message — the message a
   * call put to a person hangs on, or the turn's last one. Returns its id.
   */
  private async flush(final: boolean): Promise<string | undefined> {
    this.endReasoning();
    const s = this.segment;
    const empty = !s.text && !s.reasoning && s.calls.length === 0;
    // A turn always leaves an answer behind, even an empty one, so the thread reads as answered.
    if (empty && !(final && !this.wroteMessage)) return undefined;
    this.segment = emptySegment();
    const message = await this.a.store.appendMessage({
      threadId: this.a.input.threadId,
      role: 'assistant',
      content: s.text,
      runId: this.a.runId,
      ...(final
        ? {
            usage: {
              ...this.usage,
              ...(this.costUsd !== undefined ? { costUsd: this.costUsd } : {}),
            },
          }
        : {}),
      ...(this.a.input.agentName !== undefined ? { agentName: this.a.input.agentName } : {}),
      ...(this.a.input.persona !== undefined ? { persona: this.a.input.persona } : {}),
      ...(s.reasoning ? { reasoning: s.reasoning, reasoningMs: s.reasoningMs } : {}),
      ...(s.calls.length > 0 ? { toolCalls: s.calls } : {}),
      ...(s.results.length > 0 ? { toolResults: s.results } : {}),
    });
    this.wroteMessage = true;
    this.messageResults.set(message.id, [...s.results]);
    return message.id;
  }

  private async onPermission(req: OpenCodePermissionRequest): Promise<void> {
    if (this.asked.has(req.id)) return;
    this.asked.add(req.id);
    const { client, sessionId, input, store } = this.a;
    const action = String(req.action);
    const metadata = req.metadata ?? {};
    const raw = metadata.input ?? metadata.args;
    const args = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    await this.step();

    // Approved "for this conversation" earlier: OpenCode asked again, the answer is the same.
    const remembered = (await store.rememberedApprovals?.(input.threadId)) ?? [];
    if (remembered.includes(action)) {
      await client.permission.reply({ sessionID: sessionId, requestID: req.id, decision: 'once' });
      this.segment.calls.push({ id: req.id, name: action, input: args, kind: 'action' });
      this.segment.results.push({ id: req.id, name: action, output: { approved: true } });
      await this.write({
        kind: 'tool-input-available',
        id: req.id,
        name: action,
        input: args,
        toolKind: 'action',
      });
      await this.write({
        kind: 'approval-settled',
        id: req.id,
        status: 'approved',
        approver: this.a.approver,
        decidedVia: 'remembered',
        remember: true,
      });
      await this.write({ kind: 'tool-output', id: req.id, output: { approved: true } });
      return;
    }

    this.segment.calls.push({ id: req.id, name: action, input: args, kind: 'action' });
    const messageId = (await this.flush(false)) as string;
    await store.recordToolCall({
      toolCallId: req.id,
      messageId,
      toolName: action,
      toolType: 'action',
      input: args,
      status: 'pending_approval',
      runId: this.a.runId,
      approver: this.a.approver,
    });
    await this.write({
      kind: 'tool-input-available',
      id: req.id,
      name: action,
      input: args,
      toolKind: 'action',
    });
    await this.write({ kind: 'approval-requested', id: req.id, approver: this.a.approver });
    // OpenCode holds the execution until it is answered; the events around it keep flowing.
    void this.a.waitForHuman(req.id).then(
      (reply) => this.enqueue(() => this.decided(req.id, action, messageId, reply)),
      () => undefined,
    );
  }

  private async decided(
    id: string,
    action: string,
    messageId: string,
    reply: HumanReply,
  ): Promise<void> {
    const decision: Decision = isDecision(reply) ? reply : { approved: false };
    const { client, sessionId, store } = this.a;
    const status = decision.approved ? 'approved' : decision.expired ? 'expired' : 'rejected';
    await client.permission.reply({
      sessionID: sessionId,
      requestID: id,
      decision: decision.approved ? 'once' : 'reject',
      ...(decision.approved
        ? {}
        : {
            message: decision.expired
              ? 'Nobody approved this action in time, so it was not run.'
              : `The user denied this action${decision.reason ? `: ${decision.reason}` : ''}. Do not retry it; tell the user what you would have done.`,
          }),
    });
    const result: ToolResult = decision.approved
      ? { id, name: action, output: { approved: true } }
      : {
          id,
          name: action,
          output: { rejected: true, ...(decision.reason ? { reason: decision.reason } : {}) },
          error: decision.expired ? 'approval expired' : 'rejected by the user',
          denied: true,
          ...(decision.expired ? { expired: true } : {}),
        };
    await store.updateToolCall({
      toolCallId: id,
      status: decision.approved ? 'executed' : status === 'expired' ? 'expired' : 'rejected',
      output: result.output,
      ...(result.error !== undefined ? { error: result.error } : {}),
      ...(decision.executedByRef !== undefined ? { executedByRef: decision.executedByRef } : {}),
      ...(decision.remember === true ? { remember: true } : {}),
      ...(decision.decidedVia !== undefined ? { decidedVia: decision.decidedVia } : {}),
    });
    await this.addResult(messageId, result);
    await this.write({
      kind: 'approval-settled',
      id,
      status,
      approver: this.a.approver,
      ...(decision.executedByRef !== undefined ? { decidedBy: decision.executedByRef } : {}),
      ...(decision.decidedVia !== undefined ? { decidedVia: decision.decidedVia } : {}),
      ...(decision.remember === true ? { remember: true } : {}),
      ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
    });
    if (decision.approved)
      await this.write({ kind: 'tool-output', id, output: { approved: true } });
    else
      await this.write({
        kind: 'tool-output-denied',
        id,
        ...(decision.expired
          ? { reason: 'approval expired' }
          : decision.reason
            ? { reason: decision.reason }
            : {}),
      });
  }

  private async onForm(form: OpenCodeForm): Promise<void> {
    if (this.asked.has(form.id)) return;
    this.asked.add(form.id);
    const request = toElicitation(form.id, form);
    const input = {
      ...(request.preamble !== undefined ? { preamble: request.preamble } : {}),
      questions: request.questions,
    };
    await this.step();
    this.segment.calls.push({ id: form.id, name: ASK_TOOL_NAME, input, kind: 'ask' });
    const messageId = (await this.flush(false)) as string;
    // The store knows read/action only: a question waiting on a person is what `action` +
    // `pending_approval` already mean (the loop records its own questions the same way).
    await this.a.store.recordToolCall({
      toolCallId: form.id,
      messageId,
      toolName: ASK_TOOL_NAME,
      toolType: 'action',
      input,
      status: 'pending_approval',
      runId: this.a.runId,
    });
    await this.write({ kind: 'elicitation', id: form.id, request });
    void this.a.waitForHuman(form.id).then(
      (reply) => this.enqueue(() => this.answered(form, request, messageId, reply)),
      () => undefined,
    );
  }

  private async answered(
    form: OpenCodeForm,
    request: ElicitationRequest,
    messageId: string,
    reply: HumanReply,
  ): Promise<void> {
    const { client, sessionId } = this.a;
    const answer: ElicitationReply = isDecision(reply) ? { answers: {}, skipped: true } : reply;
    if (answer.skipped === true) {
      await client.session.form.cancel({ sessionID: sessionId, formID: form.id });
    } else {
      await client.session.form.reply({
        sessionID: sessionId,
        formID: form.id,
        answer: toFormAnswer(form, answer.answers),
      });
    }
    const result = settleElicitation(request, answer);
    await this.a.store.updateToolCall({
      toolCallId: form.id,
      status: result.skipped ? 'rejected' : 'executed',
      output: result,
      ...(result.skipped ? { error: 'skipped by the user' } : {}),
      ...(answer.answeredByRef !== undefined ? { executedByRef: answer.answeredByRef } : {}),
      ...(answer.answeredVia !== undefined ? { decidedVia: answer.answeredVia } : {}),
    });
    await this.addResult(messageId, { id: form.id, name: ASK_TOOL_NAME, output: result });
    await this.write({ kind: 'tool-output', id: form.id, output: result });
  }

  private async addResult(messageId: string, result: ToolResult): Promise<void> {
    const results = [...(this.messageResults.get(messageId) ?? []), result];
    this.messageResults.set(messageId, results);
    await this.a.store.setMessageToolResults(messageId, results);
  }

  private async end(outcome: TurnOutcome): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    if (outcome.status !== 'failed' || this.segment.text || this.segment.calls.length > 0) {
      await this.flush(true);
    }
    if (this.stepOpen) {
      this.stepOpen = false;
      await this.write({ kind: 'step-finish' });
    }
    this.finish(outcome);
  }
}
