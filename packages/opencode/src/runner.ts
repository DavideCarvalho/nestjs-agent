import type { AgentDepsFactory } from '@dudousxd/nestjs-agent';
import { ChatQueueService } from '@dudousxd/nestjs-agent';
import {
  AGENT_DEPS_FACTORY,
  AGENT_SINK,
  AGENT_STORE,
  type AgentRunInput,
  type AgentRunStartOptions,
  type AgentRunner,
  type AgentStore,
  type HumanReply,
  type PromptContext,
  RUN_ENDED_BEFORE_TOOL_CALL,
  RunCancelledError,
  type SinkWriter,
  type StoredMessage,
  type TokenStreamSink,
  encodeStreamEvent,
  publishAgentRunFailed,
  releaseThreadRun,
} from '@dudousxd/nestjs-agent-core';
import { Inject, Injectable, Logger, type OnApplicationShutdown, Optional } from '@nestjs/common';
import type { OpenCodeClient } from './client.js';
import { OpenCodeEventHub } from './event-hub.js';
import type { OpenCodeHost, OpenCodeServer, OpenCodeSessionStore } from './host.js';
import { OPENCODE_HOST, OPENCODE_OPTIONS, OPENCODE_SESSIONS } from './tokens.js';
import { OpenCodeTurn, type TurnOutcome } from './turn.js';

export interface OpenCodeRunnerOptions {
  /** Who approves an action OpenCode asks permission for. Default `'requester'`. */
  approver?: string;
  /** How many earlier messages a NEW session is told about (a thread whose session was lost). Default 20. */
  historyMessages?: number;
  /** The instructions key the agent's own prompt is put under. Default `'aviary.system'`. */
  systemKey?: string;
}

interface LiveRun {
  client?: OpenCodeClient;
  sessionId?: string;
}

/**
 * Runs turns on OpenCode 2 sessions (one per thread, created on the host's OpenCode server) and
 * makes them look like the library's own: the user message and the answers in the store, the
 * protocol's frames on the sink, approvals and questions parked on the run until
 * `AgentService.approve` / `answer` signal it, the queue handed off when the turn ends.
 *
 * In-process, like `InlineAgentRunner`: a run parked on a person lives in this process's memory, so
 * deploy it single-replica, or route decisions to the replica that holds the run.
 */
@Injectable()
export class OpenCodeAgentRunner implements AgentRunner, OnApplicationShutdown {
  private readonly logger = new Logger(OpenCodeAgentRunner.name);
  private readonly events = new OpenCodeEventHub();
  private readonly live = new Map<string, LiveRun>();
  private readonly cancelled = new Set<string>();
  private readonly pending = new Map<
    string,
    { resolve: (reply: HumanReply) => void; reject: (error: unknown) => void }
  >();

  constructor(
    @Inject(OPENCODE_HOST) private readonly host: OpenCodeHost,
    @Inject(OPENCODE_SESSIONS) private readonly sessions: OpenCodeSessionStore,
    @Inject(OPENCODE_OPTIONS) private readonly options: OpenCodeRunnerOptions,
    @Inject(AGENT_STORE) private readonly store: AgentStore,
    @Inject(AGENT_SINK) private readonly sink: TokenStreamSink,
    @Inject(AGENT_DEPS_FACTORY) private readonly deps: AgentDepsFactory,
    @Optional() private readonly queue?: ChatQueueService,
  ) {}

  onApplicationShutdown(): void {
    this.events.close();
  }

  async isRunActive(runId: string): Promise<boolean> {
    if (this.live.has(runId)) return true;
    for (const key of this.pending.keys()) if (key.startsWith(`${runId}:`)) return true;
    return false;
  }

  async start(
    input: AgentRunInput,
    options: AgentRunStartOptions = {},
  ): Promise<{ runId: string }> {
    const runId = options.runId ?? crypto.randomUUID();
    this.live.set(runId, {});
    void this.run(runId, input)
      .catch((error: unknown) => this.settleFailed(runId, input, error))
      .finally(() => {
        this.live.delete(runId);
        this.cancelled.delete(runId);
        for (const key of [...this.pending.keys()])
          if (key.startsWith(`${runId}:`)) this.pending.delete(key);
      });
    return { runId };
  }

  async signal(runId: string, toolCallId: string, reply: HumanReply): Promise<void> {
    const key = `${runId}:${toolCallId}`;
    const waiter = this.pending.get(key);
    if (waiter === undefined) return;
    this.pending.delete(key);
    waiter.resolve(reply);
  }

  /**
   * Stop the run: OpenCode is interrupted (it answers with `session.execution.interrupted`, which
   * settles the run as cancelled) and whatever it was waiting on a person for is dropped.
   */
  async cancel(runId: string): Promise<void> {
    this.cancelled.add(runId);
    for (const [key, waiter] of [...this.pending]) {
      if (!key.startsWith(`${runId}:`)) continue;
      this.pending.delete(key);
      waiter.reject(new RunCancelledError());
    }
    const run = this.live.get(runId);
    if (run?.client !== undefined && run.sessionId !== undefined) {
      await run.client.session.interrupt({ sessionID: run.sessionId }).catch((error: unknown) => {
        this.logger.warn(`interrupting run ${runId} failed: ${(error as Error).message}`);
      });
    }
  }

  private waitForHuman(runId: string, toolCallId: string): Promise<HumanReply> {
    return new Promise((resolve, reject) => {
      this.pending.set(`${runId}:${toolCallId}`, { resolve, reject });
    });
  }

  private async run(runId: string, input: AgentRunInput): Promise<void> {
    const started = Date.now();
    const server = await this.host.server(input.actor);
    const earlier = await this.prepareThread(runId, input);
    const sessionId = await this.sessionFor(runId, input, server, earlier);
    const live = this.live.get(runId);
    if (live !== undefined) Object.assign(live, { client: server.client, sessionId });
    if (this.cancelled.has(runId)) throw new RunCancelledError();

    const writer = await this.sink.open(runId);
    const turn = new OpenCodeTurn({
      runId,
      input,
      client: server.client,
      sessionId,
      writer,
      store: this.store,
      waitForHuman: (toolCallId) => this.waitForHuman(runId, toolCallId),
      approver: this.options.approver ?? 'requester',
      modelLabel: input.model ?? 'opencode',
      logger: this.logger,
    });
    const stop = await this.events.listen(server.key, server.client, sessionId, (event) =>
      turn.handle(event),
    );
    let outcome: TurnOutcome;
    try {
      await server.client.session
        .prompt({
          sessionID: sessionId,
          text: input.userText,
          ...(input.attachments?.length && this.host.files
            ? { files: await this.host.files({ input, runId }) }
            : {}),
        })
        .catch((error: unknown) =>
          turn.fail(`OpenCode refused the message: ${(error as Error).message}`),
        );
      outcome = await turn.done;
    } finally {
      stop();
    }
    await this.settle(runId, input, writer, outcome, Date.now() - started);
  }

  /** The user message, as the loop persists it (or, on a regenerate, the thread rewound to it). */
  private async prepareThread(runId: string, input: AgentRunInput): Promise<StoredMessage[]> {
    const thread = await this.store.getThread(input.threadId);
    const messages = thread?.messages ?? [];
    if (input.regenerate === true) {
      let lastUser = -1;
      for (let i = messages.length - 1; i >= 0; i -= 1)
        if (messages[i]?.role === 'user') {
          lastUser = i;
          break;
        }
      const firstDropped = messages[lastUser + 1];
      if (firstDropped !== undefined)
        await this.store.truncateFrom(input.threadId, firstDropped.id);
      return messages.slice(0, Math.max(lastUser, 0));
    }
    await this.store.appendMessage({
      threadId: input.threadId,
      role: 'user',
      content: input.userText,
      runId,
      ...(input.persona !== undefined ? { persona: input.persona } : {}),
      ...(input.attachments !== undefined ? { attachments: input.attachments } : {}),
    });
    if (thread !== null && (thread.title === '' || thread.title === 'New chat')) {
      await this.store.setTitle(input.threadId, titleOf(input.userText));
    }
    return messages;
  }

  /**
   * The thread's session on this server, or a new one: created as the host says, primed with the
   * host's `prepare` and, when the thread already has a conversation the session never saw, a
   * transcript of it. The agent's prompt and the host's entries are refreshed on every turn.
   */
  private async sessionFor(
    runId: string,
    input: AgentRunInput,
    server: OpenCodeServer,
    earlier: StoredMessage[],
  ): Promise<string> {
    const { client } = server;
    const context = { input, runId };
    const known = await this.sessions.get(input.threadId);
    let sessionId: string;
    if (known !== null && known.serverKey === server.key && known.bootId === server.bootId) {
      sessionId = known.sessionId;
    } else {
      const spec = await this.host.session(context);
      sessionId = (
        await client.session.create({
          ...spec,
          metadata: { ...(spec.metadata ?? {}), threadId: input.threadId },
        })
      ).id;
      await this.sessions.set(input.threadId, {
        sessionId,
        serverKey: server.key,
        ...(server.bootId !== undefined ? { bootId: server.bootId } : {}),
      });
      await this.host.prepare?.({ ...context, sessionId, client });
      const transcript = transcriptOf(earlier, this.options.historyMessages ?? 20);
      if (transcript) {
        await client.session.instructions.entry.put({
          sessionID: sessionId,
          key: 'aviary.history',
          value: `The conversation so far (continue it; do not repeat it):\n${transcript}`,
        });
      }
    }
    const entries: Record<string, string> = {
      [this.options.systemKey ?? 'aviary.system']: await this.systemPrompt(input),
      ...((await this.host.instructions?.({ ...context, sessionId })) ?? {}),
    };
    for (const [key, value] of Object.entries(entries)) {
      await client.session.instructions.entry.put({ sessionID: sessionId, key, value });
    }
    return sessionId;
  }

  /** The agent's base prompt (`@Agent({ systemPrompt })` / `@SystemPrompt()`) and the contributors. */
  private async systemPrompt(input: AgentRunInput): Promise<string> {
    const deps = this.deps.forAgent(input.agentName);
    const ctx: PromptContext = {
      actor: input.actor,
      agentName: input.agentName ?? 'default',
      ...(input.pageContext !== undefined ? { pageContext: input.pageContext } : {}),
      ...(input.uiCapabilities !== undefined ? { uiCapabilities: input.uiCapabilities } : {}),
    };
    const base =
      typeof deps.systemPrompt === 'function' ? await deps.systemPrompt(ctx) : deps.systemPrompt;
    const sections = [base];
    for (const contribute of deps.promptContributors) {
      const section = await contribute(ctx);
      if (section) sections.push(section);
    }
    return sections.filter(Boolean).join('\n\n');
  }

  private async settle(
    runId: string,
    input: AgentRunInput,
    writer: SinkWriter,
    outcome: TurnOutcome,
    durationMs: number,
  ): Promise<void> {
    if (outcome.status === 'failed') throw new Error(outcome.error);
    if (outcome.status === 'interrupted' || this.cancelled.has(runId)) {
      this.logger.log(`agent run ${runId} cancelled`);
      await Promise.resolve(
        this.store.failUnsettledToolCalls?.(runId, RUN_ENDED_BEFORE_TOOL_CALL),
      ).catch(() => 0);
      await this.settleQueue(writer, input, runId, 'cancelled');
      await releaseThreadRun(this.store, input.threadId, runId);
      await writer.write(encodeStreamEvent({ kind: 'cancelled' }));
      await writer.end();
      await this.store.recordRunEnd?.({ runId, status: 'cancelled', durationMs });
      return;
    }
    await this.settleQueue(writer, input, runId, 'completed');
    await releaseThreadRun(this.store, input.threadId, runId);
    await writer.end();
    await this.store.recordRunEnd?.({ runId, status: 'completed', durationMs });
  }

  private async settleFailed(runId: string, input: AgentRunInput, error: unknown): Promise<void> {
    if (error instanceof RunCancelledError) {
      const writer = await this.sink.open(runId);
      await this.settle(runId, input, writer, { status: 'interrupted' }, 0);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    this.logger.error(`agent run ${runId} failed: ${message}`);
    publishAgentRunFailed({ runId, code: 'opencode_failed', message });
    await this.store.recordRunEnd?.({
      runId,
      status: 'failed',
      errorCode: 'opencode_failed',
      errorMessage: message,
    });
    await Promise.resolve(
      this.store.failUnsettledToolCalls?.(runId, RUN_ENDED_BEFORE_TOOL_CALL),
    ).catch(() => 0);
    const writer = await this.sink.open(runId);
    await this.settleQueue(writer, input, runId, 'failed', message);
    await releaseThreadRun(this.store, input.threadId, runId);
    await writer.fail({ code: 'opencode_failed', message });
  }

  /** As `InlineAgentRunner`: hand the thread to its next queued message, and say so on the stream. */
  private async settleQueue(
    writer: SinkWriter,
    input: AgentRunInput,
    runId: string,
    outcome: 'completed' | 'failed' | 'cancelled',
    error?: string,
  ): Promise<void> {
    const queue = this.queue;
    if (queue === undefined || !queue.supported) return;
    if (input.sinkRunId !== undefined || input.deliverTo !== undefined) return;
    try {
      const frame = await queue.handoff(
        { threadId: input.threadId, runId, outcome, ...(error !== undefined ? { error } : {}) },
        (next, nextRunId) => this.start(next, { runId: nextRunId }),
      );
      if (frame !== undefined) await writer.write(encodeStreamEvent(frame));
    } catch (failure) {
      this.logger.error(
        `could not advance the queue of thread ${input.threadId} after run ${runId}: ${
          failure instanceof Error ? failure.message : String(failure)
        }`,
      );
    }
  }
}

function titleOf(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  return trimmed.length > 60 ? `${trimmed.slice(0, 57)}...` : trimmed || 'New chat';
}

function transcriptOf(messages: StoredMessage[], limit: number): string {
  return messages
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content.trim())
    .slice(-limit)
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 2000)}`)
    .join('\n');
}
