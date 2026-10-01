import type { ToolCallOutcome } from './dangling-tool-calls.js';
import {
  type AgentStore,
  type AppendMessageInput,
  type CreateThreadInput,
  type RecordRunStartInput,
  type RecordToolCallInput,
  type RecordUsageInput,
  type ToolCallApprovalState,
  type UpdateThreadInput,
  type UpdateToolCallInput,
} from './spi/agent-store.js';
import { toolCallApprovalFromRow } from './spi/approval-policy.js';
import type {
  ChatQueueStore,
  EnqueueMessageInput,
  QueuePause,
  QueuedMessage,
  QueuedMessagePatch,
} from './spi/chat-queue.js';
import { type AgentUiComponent } from './stream-events.js';
import {
  type MessageFeedback,
  type StoredMessage,
  type ThreadDetail,
  type ThreadSummary,
  type ToolCallApproval,
  type ToolCallStatus,
  type ToolResult,
} from './types.js';

interface ThreadRow extends ThreadSummary {
  actorRef: string;
  activeStreamId?: string;
  messages: StoredMessage[];
}

interface ToolCallRow {
  toolCallId: string;
  messageId: string;
  threadId: string;
  toolName: string;
  toolType: 'read' | 'action';
  input: unknown;
  output?: unknown;
  status: ToolCallStatus;
  error?: string;
  executionMs?: number;
  createdAt: string;
  /** The run this call belongs to; `undefined` when the caller didn't supply one. */
  runId?: string;
  executedByRef?: string;
  approver?: string;
  expiresAt?: string;
  remember?: boolean;
  decidedVia?: string;
}

interface UsageRow {
  actorRef: string;
  threadId: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
  costUsd?: number;
  day: string;
  createdAt: string;
}

/** A recorded usage row exposed to the governance read-model (input/output split + thread/day). */
export interface GovernanceUsageRow {
  actorRef: string;
  threadId: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  /** Subset of `inputTokens` written to the prompt cache this turn; undefined when not reported. */
  cacheWriteTokens?: number;
  /** Subset of `inputTokens` served from the prompt cache this turn; undefined when not reported. */
  cacheReadTokens?: number;
  /** Provider-reported actual cost for the turn, when known; undefined → estimate from pricing. */
  costUsd?: number;
  day: string;
  createdAt: string;
}

/** A recorded tool call exposed to the governance read-model (thread resolved, with timestamp). */
export interface GovernanceToolCallRow {
  toolCallId: string;
  toolName: string;
  toolType: 'read' | 'action';
  status: ToolCallStatus;
  threadId: string;
  /** The message that requested the call — the thread drill-down groups by it. */
  messageId: string;
  /** Wall-clock milliseconds the tool took to run; undefined when it never recorded one. */
  executionMs?: number;
  /** The failure text for a `failed` call; undefined otherwise. */
  error?: string;
  createdAt: string;
  /** The run this call belongs to; undefined when the caller didn't supply one. */
  runId?: string;
}

/** A stored message exposed to the governance read-model (the thread drill-down's transcript). */
export interface GovernanceMessageRow {
  messageId: string;
  threadId: string;
  role: string;
  content: string;
  agentName?: string;
  createdAt: string;
}

/** A tool call awaiting a HITL decision, joined to its thread + message for the approvals inbox. */
export interface GovernancePendingApprovalRow {
  toolCallId: string;
  toolName: string;
  input: unknown;
  threadId: string;
  threadTitle: string;
  actorRef: string;
  agentName?: string;
  requestedAt: string;
  /** The run this call belongs to; undefined when the caller didn't supply one. */
  runId?: string;
}

/** Thread metadata exposed to the governance read-model (title/actor/count/last activity). */
export interface GovernanceThreadRow {
  threadId: string;
  title: string;
  actorRef: string;
  messageCount: number;
  updatedAt: string;
}

interface RunRow {
  runId: string;
  threadId: string;
  actorRef: string;
  agentName?: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  durationMs?: number;
  errorCode?: string;
  errorMessage?: string;
  retries: number;
  startedAt: string;
  settledAt?: string;
  /** sha256 hex of the run's resolved (pre-RAG) system prompt; undefined for a pre-existing run. */
  promptHash?: string;
  /** The run that delegated this one; undefined for a turn nobody delegated. */
  parentRunId?: string;
}

/** A recorded run outcome exposed to the governance read-model (reliability surfaces). */
export interface GovernanceRunRow {
  runId: string;
  threadId: string;
  actorRef: string;
  agentName?: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  durationMs?: number;
  errorCode?: string;
  errorMessage?: string;
  retries: number;
  startedAt: string;
  settledAt?: string;
  promptHash?: string;
  /**
   * The run that delegated this one; undefined for a turn nobody delegated. The edge exists in the
   * durable journal too, but a reader of run rows has only this — and a DETACHED child outlives its
   * parent's turn, so nothing in the transcript pairs them either.
   */
  parentRunId?: string;
}

/** A fully in-memory `AgentStore` for tests and the offline demo. */
export class InMemoryAgentStore implements AgentStore, ChatQueueStore {
  private readonly threads = new Map<string, ThreadRow>();
  /** Each thread's waiting messages, in run order. */
  private readonly queues = new Map<string, QueuedMessage[]>();
  private readonly pauses = new Map<string, QueuePause>();
  private readonly toolCalls = new Map<string, ToolCallRow>();
  private readonly usage: UsageRow[] = [];
  private readonly runs = new Map<string, RunRow>();

  private now(): string {
    return new Date().toISOString();
  }

  async createThread(input: CreateThreadInput): Promise<ThreadSummary> {
    const id = input.id ?? crypto.randomUUID();
    if (this.threads.has(id)) {
      throw new Error(`thread ${id} already exists`);
    }
    const ts = this.now();
    const row: ThreadRow = {
      id,
      actorRef: input.actor.id,
      title: input.title ?? 'New chat',
      transient: input.transient ?? false,
      createdAt: ts,
      updatedAt: ts,
      messages: [],
    };
    this.threads.set(id, row);
    return this.toSummary(row);
  }

  async getThread(threadId: string): Promise<ThreadDetail | null> {
    const row = this.threads.get(threadId);
    if (row === undefined) {
      return null;
    }
    return {
      ...this.toSummary(row),
      messages: row.messages.map((message) => this.withApprovals(message)),
      // The run streaming right now — the one field the read-model reports it under.
      ...(row.activeStreamId !== undefined ? { activeRunId: row.activeStreamId } : {}),
    };
  }

  /** A message with the approval record of every call on it that was put to a person. */
  private withApprovals(message: StoredMessage): StoredMessage {
    const approvals: ToolCallApproval[] = [];
    for (const call of this.toolCalls.values()) {
      if (call.messageId !== message.id) {
        continue;
      }
      const approval = toolCallApprovalFromRow({
        toolCallId: call.toolCallId,
        status: call.status,
        approver: call.approver,
        expiresAt: call.expiresAt,
        remember: call.remember,
        executedByRef: call.executedByRef,
        decidedVia: call.decidedVia,
        error: call.error,
      });
      if (approval !== null) {
        approvals.push(approval);
      }
    }
    return approvals.length > 0 ? { ...message, approvals } : message;
  }

  async rememberedApprovals(threadId: string): Promise<string[]> {
    const names = new Set<string>();
    for (const call of this.toolCalls.values()) {
      if (call.threadId === threadId && call.remember === true) {
        names.add(call.toolName);
      }
    }
    return [...names];
  }

  async toolCallInput(toolCallId: string): Promise<unknown> {
    return this.toolCalls.get(toolCallId)?.input ?? null;
  }

  async toolCallApproval(toolCallId: string): Promise<ToolCallApprovalState | null> {
    const call = this.toolCalls.get(toolCallId);
    if (call === undefined) {
      return null;
    }
    return {
      status: call.status,
      approver: call.approver ?? null,
      expiresAt: call.expiresAt ?? null,
    };
  }

  async listThreads(actorRef: string, limit = 50): Promise<ThreadSummary[]> {
    return [...this.threads.values()]
      .filter((row) => row.actorRef === actorRef && !row.transient)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit)
      .map((row) => this.toSummary(row));
  }

  async softDeleteThread(threadId: string): Promise<void> {
    this.threads.delete(threadId);
  }

  async forkThread(threadId: string, fromMessageId: string): Promise<ThreadSummary> {
    const source = this.threads.get(threadId);
    if (source === undefined) {
      throw new Error(`thread ${threadId} not found`);
    }
    const cutoff = source.messages.findIndex((message) => message.id === fromMessageId);
    const kept = cutoff >= 0 ? source.messages.slice(0, cutoff + 1) : [...source.messages];
    const id = crypto.randomUUID();
    const ts = this.now();
    const row: ThreadRow = {
      id,
      actorRef: source.actorRef,
      title: source.title,
      transient: false,
      createdAt: ts,
      updatedAt: ts,
      // Feedback rates a message in ITS thread; a fork starts unrated.
      messages: kept.map(({ feedback: _feedback, ...message }) => ({ ...message })),
      ...(source.defaultAgent != null ? { defaultAgent: source.defaultAgent } : {}),
      ...(source.model != null ? { model: source.model } : {}),
    };
    this.threads.set(id, row);
    return this.toSummary(row);
  }

  async ownerOfThread(threadId: string): Promise<string | null> {
    return this.threads.get(threadId)?.actorRef ?? null;
  }

  async ownerOfToolCall(toolCallId: string): Promise<string | null> {
    const call = this.toolCalls.get(toolCallId);
    if (call === undefined) {
      return null;
    }
    return this.threads.get(call.threadId)?.actorRef ?? null;
  }

  async runForToolCall(toolCallId: string): Promise<string | null> {
    const call = this.toolCalls.get(toolCallId);
    if (call === undefined) {
      return null;
    }
    return call.runId ?? this.threads.get(call.threadId)?.activeStreamId ?? null;
  }

  async ownerOfActiveStream(runId: string): Promise<string | null> {
    for (const row of this.threads.values()) {
      if (row.activeStreamId === runId) {
        return row.actorRef;
      }
    }
    return null;
  }

  async setTitle(threadId: string, title: string): Promise<void> {
    const row = this.threads.get(threadId);
    if (row !== undefined) {
      row.title = title;
      row.updatedAt = this.now();
    }
  }

  async updateThread(threadId: string, patch: UpdateThreadInput): Promise<void> {
    const row = this.threads.get(threadId);
    if (row === undefined) {
      return;
    }
    if (patch.title !== undefined) {
      row.title = patch.title;
    }
    if (patch.defaultAgent !== undefined) {
      row.defaultAgent = patch.defaultAgent;
    }
    if (patch.model !== undefined) {
      row.model = patch.model;
    }
    row.updatedAt = this.now();
  }

  async activeRunForThread(threadId: string): Promise<string | null> {
    return this.threads.get(threadId)?.activeStreamId ?? null;
  }

  /**
   * The thread's default agent, projected. A map lookup here, but the SQL adapters answer this with
   * a one-column read instead of materializing the whole transcript — so the caller that only needs
   * this scalar has a method to ask for it.
   */
  async defaultAgentForThread(threadId: string): Promise<string | null> {
    return this.threads.get(threadId)?.defaultAgent ?? null;
  }

  /** The thread's pinned model, projected like {@link defaultAgentForThread}. */
  async modelForThread(threadId: string): Promise<string | null> {
    return this.threads.get(threadId)?.model ?? null;
  }

  /**
   * Persist the start of a run (turn). Replay-safe: called under a durable localStep.
   *
   * Takes the SPI's own {@link RecordRunStartInput} rather than a hand-copied shape: a field added
   * to the input is otherwise accepted and dropped, silently, by every adapter that re-declares it.
   */
  async recordRunStart(run: RecordRunStartInput): Promise<void> {
    this.runs.set(run.runId, {
      runId: run.runId,
      threadId: run.threadId,
      actorRef: run.actorRef,
      status: 'running',
      retries: 0,
      startedAt: this.now(),
      ...(run.agentName !== undefined ? { agentName: run.agentName } : {}),
      ...(run.parentRunId !== undefined ? { parentRunId: run.parentRunId } : {}),
      ...(run.promptHash !== undefined ? { promptHash: run.promptHash } : {}),
    });
  }

  /** Settle a run's outcome. A no-op when the run is unknown (mirrors `setTitle`/`updateThread`). */
  async recordRunEnd(end: {
    runId: string;
    status: 'completed' | 'failed' | 'cancelled';
    durationMs?: number;
    errorCode?: string;
    errorMessage?: string;
  }): Promise<void> {
    const row = this.runs.get(end.runId);
    if (row === undefined) {
      return;
    }
    row.status = end.status;
    row.settledAt = this.now();
    if (end.durationMs !== undefined) {
      row.durationMs = end.durationMs;
    }
    if (end.errorCode !== undefined) {
      row.errorCode = end.errorCode;
    }
    if (end.errorMessage !== undefined) {
      row.errorMessage = end.errorMessage;
    }
  }

  /** Bump the run's llm-step retry counter. */
  async bumpRunRetries(runId: string): Promise<void> {
    const row = this.runs.get(runId);
    if (row !== undefined) {
      row.retries += 1;
    }
  }

  async promoteThread(threadId: string): Promise<void> {
    const row = this.threads.get(threadId);
    if (row?.transient) {
      row.transient = false;
      row.updatedAt = this.now();
    }
  }

  async setActiveStream(threadId: string, runId: string | null): Promise<void> {
    const row = this.threads.get(threadId);
    if (row !== undefined) {
      if (runId === null) {
        // biome-ignore lint/performance/noDelete: exactOptionalPropertyTypes forbids assigning undefined to an optional prop
        delete row.activeStreamId;
      } else {
        row.activeStreamId = runId;
      }
    }
  }

  async claimActiveStream(
    threadId: string,
    runId: string,
    options: { replacing?: string } = {},
  ): Promise<boolean> {
    const row = this.threads.get(threadId);
    if (row === undefined) {
      return false;
    }
    const holder = row.activeStreamId;
    if (holder !== undefined && holder !== runId && holder !== options.replacing) {
      return false;
    }
    row.activeStreamId = runId;
    return true;
  }

  async releaseActiveStream(threadId: string, runId: string): Promise<boolean> {
    const row = this.threads.get(threadId);
    if (row?.activeStreamId !== runId) {
      return false;
    }
    // biome-ignore lint/performance/noDelete: exactOptionalPropertyTypes forbids assigning undefined to an optional prop
    delete row.activeStreamId;
    return true;
  }

  async enqueueMessage(input: EnqueueMessageInput): Promise<QueuedMessage> {
    const ts = this.now();
    const message: QueuedMessage = {
      id: crypto.randomUUID(),
      threadId: input.threadId,
      actor: input.actor,
      content: input.content,
      ...(input.attachments !== undefined && input.attachments.length > 0
        ? { attachments: input.attachments }
        : {}),
      ...(input.agentName !== undefined ? { agentName: input.agentName } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.pageContext !== undefined ? { pageContext: input.pageContext } : {}),
      ...(input.interrupt === true ? { interrupt: true } : {}),
      createdAt: ts,
      updatedAt: ts,
    };
    const queue = this.queues.get(input.threadId) ?? [];
    if (input.at === 'head') {
      queue.unshift(message);
    } else {
      queue.push(message);
    }
    this.queues.set(input.threadId, queue);
    return { ...message };
  }

  async listQueue(threadId: string): Promise<QueuedMessage[]> {
    return (this.queues.get(threadId) ?? []).map((message) => ({ ...message }));
  }

  async getQueuedMessage(id: string): Promise<QueuedMessage | null> {
    const found = this.findQueued(id);
    return found === undefined ? null : { ...found.message };
  }

  async updateQueuedMessage(id: string, patch: QueuedMessagePatch): Promise<QueuedMessage | null> {
    const found = this.findQueued(id);
    if (found === undefined) {
      return null;
    }
    const { message } = found;
    if (patch.content !== undefined) {
      message.content = patch.content;
    }
    if (patch.attachments !== undefined) {
      if (patch.attachments === null || patch.attachments.length === 0) {
        // biome-ignore lint/performance/noDelete: exactOptionalPropertyTypes forbids assigning undefined to an optional prop
        delete message.attachments;
      } else {
        message.attachments = patch.attachments;
      }
    }
    if (patch.interrupt !== undefined) {
      if (patch.interrupt) {
        message.interrupt = true;
      } else {
        // biome-ignore lint/performance/noDelete: exactOptionalPropertyTypes forbids assigning undefined to an optional prop
        delete message.interrupt;
      }
    }
    message.updatedAt = this.now();
    return { ...message };
  }

  async moveQueuedMessage(id: string, index: number): Promise<boolean> {
    const found = this.findQueued(id);
    if (found === undefined) {
      return false;
    }
    const { queue, position, message } = found;
    queue.splice(position, 1);
    const target = Math.max(0, Math.min(queue.length, Math.trunc(index)));
    queue.splice(target, 0, message);
    return true;
  }

  async removeQueuedMessage(id: string): Promise<boolean> {
    const found = this.findQueued(id);
    if (found === undefined) {
      return false;
    }
    found.queue.splice(found.position, 1);
    return true;
  }

  async clearQueue(threadId: string): Promise<number> {
    const count = this.queues.get(threadId)?.length ?? 0;
    this.queues.delete(threadId);
    return count;
  }

  async queuePause(threadId: string): Promise<QueuePause | null> {
    return this.pauses.get(threadId) ?? null;
  }

  async setQueuePause(threadId: string, pause: QueuePause | null): Promise<void> {
    if (pause === null) {
      this.pauses.delete(threadId);
    } else {
      this.pauses.set(threadId, pause);
    }
  }

  private findQueued(
    id: string,
  ): { queue: QueuedMessage[]; position: number; message: QueuedMessage } | undefined {
    for (const queue of this.queues.values()) {
      const position = queue.findIndex((message) => message.id === id);
      const message = queue[position];
      if (message !== undefined) {
        return { queue, position, message };
      }
    }
    return undefined;
  }

  async appendMessage(input: AppendMessageInput): Promise<StoredMessage> {
    const row = this.threads.get(input.threadId);
    if (row === undefined) {
      throw new Error(`thread ${input.threadId} not found`);
    }
    const message: StoredMessage = {
      id: crypto.randomUUID(),
      role: input.role,
      content: input.content,
      createdAt: this.now(),
      ...(input.toolCalls !== undefined ? { toolCalls: input.toolCalls } : {}),
      ...(input.toolResults !== undefined ? { toolResults: input.toolResults } : {}),
      ...(input.attachments !== undefined ? { attachments: input.attachments } : {}),
      ...(input.followUps !== undefined ? { followUps: input.followUps } : {}),
      ...(input.usage !== undefined ? { usage: input.usage } : {}),
      ...(input.agentName !== undefined ? { agentName: input.agentName } : {}),
      ...(input.runId !== undefined ? { runId: input.runId } : {}),
      ...(input.reasoning !== undefined ? { reasoning: input.reasoning } : {}),
      ...(input.reasoningMs !== undefined ? { reasoningMs: input.reasoningMs } : {}),
      ...(input.ui !== undefined ? { ui: input.ui } : {}),
    };
    row.messages.push(message);
    row.updatedAt = message.createdAt;
    return message;
  }

  async setMessageToolResults(messageId: string, results: ToolResult[]): Promise<void> {
    for (const row of this.threads.values()) {
      const message = row.messages.find((candidate) => candidate.id === messageId);
      if (message !== undefined) {
        message.toolResults = results;
        return;
      }
    }
  }

  async setMessageUi(messageId: string, ui: AgentUiComponent[]): Promise<void> {
    for (const row of this.threads.values()) {
      const index = row.messages.findIndex((candidate) => candidate.id === messageId);
      const message = row.messages[index];
      if (message !== undefined) {
        const { ui: _previous, ...rest } = message;
        row.messages[index] = ui.length > 0 ? { ...rest, ui } : rest;
        return;
      }
    }
  }

  async threadOfMessage(messageId: string): Promise<string | null> {
    return this.threadIdForMessage(messageId) ?? null;
  }

  async setMessageFeedback(messageId: string, feedback: MessageFeedback | null): Promise<void> {
    for (const row of this.threads.values()) {
      const index = row.messages.findIndex((candidate) => candidate.id === messageId);
      const message = row.messages[index];
      if (message !== undefined) {
        const { feedback: _previous, ...rest } = message;
        row.messages[index] = feedback !== null ? { ...rest, feedback } : rest;
        return;
      }
    }
  }

  async truncateFrom(threadId: string, messageId: string): Promise<void> {
    const row = this.threads.get(threadId);
    if (row === undefined) {
      return;
    }
    const cutoff = row.messages.findIndex((message) => message.id === messageId);
    if (cutoff >= 0) {
      row.messages = row.messages.slice(0, cutoff);
    }
  }

  /**
   * Of `mediaIds`, the ones a surviving message — or a message waiting in the queue — in one of
   * this actor's threads still carries.
   * Re-derived from the messages each call, so a media whose message was truncated away reads as
   * unreferenced again.
   */
  async referencedMediaIds(actorRef: string, mediaIds: readonly string[]): Promise<string[]> {
    if (mediaIds.length === 0) {
      return [];
    }
    const wanted = new Set(mediaIds);
    const found = new Set<string>();
    for (const thread of this.threads.values()) {
      if (thread.actorRef !== actorRef) {
        continue;
      }
      // A message waiting in the thread's queue carries its attachments too: it has been sent, it
      // just has not run yet — collecting its media would fail the turn it is waiting to start.
      const queued = this.queues.get(thread.id) ?? [];
      for (const message of [...thread.messages, ...queued]) {
        for (const attachment of message.attachments ?? []) {
          if (wanted.has(attachment.mediaId)) {
            found.add(attachment.mediaId);
          }
        }
      }
    }
    return [...wanted].filter((mediaId) => found.has(mediaId));
  }

  async recordToolCall(input: RecordToolCallInput): Promise<void> {
    this.toolCalls.set(input.toolCallId, {
      toolCallId: input.toolCallId,
      messageId: input.messageId,
      threadId: this.threadIdForMessage(input.messageId) ?? '',
      toolName: input.toolName,
      toolType: input.toolType,
      input: input.input,
      status: input.status,
      createdAt: this.now(),
      ...(input.runId !== undefined ? { runId: input.runId } : {}),
      ...(input.approver !== undefined ? { approver: input.approver } : {}),
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    });
  }

  async toolCallOutcomes(toolCallIds: readonly string[]): Promise<ToolCallOutcome[]> {
    const outcomes: ToolCallOutcome[] = [];
    for (const id of toolCallIds) {
      const row = this.toolCalls.get(id);
      if (row !== undefined) {
        outcomes.push({
          id,
          status: row.status,
          ...(row.output !== undefined ? { output: row.output } : {}),
          ...(row.error !== undefined ? { error: row.error } : {}),
        });
      }
    }
    return outcomes;
  }

  async failUnsettledToolCalls(runId: string, error: string): Promise<number> {
    let settled = 0;
    for (const row of this.toolCalls.values()) {
      if (row.runId === runId && row.status === 'pending_approval') {
        row.status = 'failed';
        row.error = error;
        settled += 1;
      }
    }
    return settled;
  }

  async updateToolCall(input: UpdateToolCallInput): Promise<void> {
    const row = this.toolCalls.get(input.toolCallId);
    if (row === undefined) {
      return;
    }
    row.status = input.status;
    if (input.output !== undefined) {
      row.output = input.output;
    }
    if (input.error !== undefined) {
      row.error = input.error;
    }
    if (input.executionMs !== undefined) {
      row.executionMs = input.executionMs;
    }
    if (input.executedByRef !== undefined) {
      row.executedByRef = input.executedByRef;
    }
    if (input.remember !== undefined) {
      row.remember = input.remember;
    }
    if (input.decidedVia !== undefined) {
      row.decidedVia = input.decidedVia;
    }
  }

  async recordUsage(input: RecordUsageInput): Promise<void> {
    const createdAt = this.now();
    this.usage.push({
      actorRef: input.actorRef,
      threadId: input.threadId,
      modelId: input.modelId,
      inputTokens: input.usage.inputTokens,
      outputTokens: input.usage.outputTokens,
      day: createdAt.slice(0, 10),
      createdAt,
      ...(input.usage.cacheWriteTokens !== undefined
        ? { cacheWriteTokens: input.usage.cacheWriteTokens }
        : {}),
      ...(input.usage.cacheReadTokens !== undefined
        ? { cacheReadTokens: input.usage.cacheReadTokens }
        : {}),
      ...(input.costUsd !== undefined ? { costUsd: input.costUsd } : {}),
    });
  }

  async quotaToday(
    actorRef: string,
    day: string,
  ): Promise<{ usedTokens: number; costUsd: number }> {
    return this.usageBetween(actorRef, day, day);
  }

  async usageBetween(
    actorRef: string,
    fromDay: string,
    toDay: string,
  ): Promise<{ usedTokens: number; costUsd: number }> {
    const rows = this.usage.filter(
      (row) => row.actorRef === actorRef && row.day >= fromDay && row.day <= toDay,
    );
    const usedTokens = rows.reduce((sum, row) => sum + row.inputTokens + row.outputTokens, 0);
    const costUsd = rows.reduce((sum, row) => sum + (row.costUsd ?? 0), 0);
    return { usedTokens, costUsd };
  }

  /** Test helper: read the recorded usage rows (modelId + token totals). */
  usageRows(): { actorRef: string; tokens: number; modelId: string }[] {
    return this.usage.map((row) => ({
      actorRef: row.actorRef,
      tokens: row.inputTokens + row.outputTokens,
      modelId: row.modelId,
    }));
  }

  /** Governance read-model feed: recorded usage rows with the input/output split + thread/day. */
  governanceUsage(): GovernanceUsageRow[] {
    return this.usage.map((row) => ({
      actorRef: row.actorRef,
      threadId: row.threadId,
      modelId: row.modelId,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      day: row.day,
      createdAt: row.createdAt,
      ...(row.cacheWriteTokens !== undefined ? { cacheWriteTokens: row.cacheWriteTokens } : {}),
      ...(row.cacheReadTokens !== undefined ? { cacheReadTokens: row.cacheReadTokens } : {}),
      ...(row.costUsd !== undefined ? { costUsd: row.costUsd } : {}),
    }));
  }

  /** Governance read-model feed: recorded tool calls with the resolved thread + timestamp. */
  governanceToolCalls(): GovernanceToolCallRow[] {
    return [...this.toolCalls.values()].map((row) => ({
      toolCallId: row.toolCallId,
      toolName: row.toolName,
      toolType: row.toolType,
      status: row.status,
      threadId: row.threadId,
      messageId: row.messageId,
      createdAt: row.createdAt,
      ...(row.executionMs !== undefined ? { executionMs: row.executionMs } : {}),
      ...(row.error !== undefined ? { error: row.error } : {}),
      ...(row.runId !== undefined ? { runId: row.runId } : {}),
    }));
  }

  /** Governance read-model feed: every stored message, thread-resolved, for the thread drill-down. */
  governanceMessages(): GovernanceMessageRow[] {
    const rows: GovernanceMessageRow[] = [];
    for (const thread of this.threads.values()) {
      for (const message of thread.messages) {
        rows.push({
          messageId: message.id,
          threadId: thread.id,
          role: message.role,
          content: message.content,
          createdAt: message.createdAt,
          ...(message.agentName !== undefined ? { agentName: message.agentName } : {}),
        });
      }
    }
    return rows;
  }

  /**
   * Governance read-model feed: tool calls sitting `pending_approval`, joined to their thread
   * (title/actorRef) and the message that requested them (`agentName`, when the message has one).
   */
  governancePendingApprovals(): GovernancePendingApprovalRow[] {
    const rows: GovernancePendingApprovalRow[] = [];
    for (const call of this.toolCalls.values()) {
      if (call.status !== 'pending_approval') {
        continue;
      }
      const thread = this.threads.get(call.threadId);
      if (thread === undefined) {
        continue;
      }
      const message = thread.messages.find((candidate) => candidate.id === call.messageId);
      rows.push({
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        input: call.input,
        threadId: call.threadId,
        threadTitle: thread.title,
        actorRef: thread.actorRef,
        requestedAt: call.createdAt,
        ...(message?.agentName !== undefined ? { agentName: message.agentName } : {}),
        ...(call.runId !== undefined ? { runId: call.runId } : {}),
      });
    }
    return rows;
  }

  /** Governance read-model feed: thread metadata (title/actor/message count/last activity). */
  governanceThreads(): GovernanceThreadRow[] {
    return [...this.threads.values()].map((row) => ({
      threadId: row.id,
      title: row.title,
      actorRef: row.actorRef,
      messageCount: row.messages.length,
      updatedAt: row.updatedAt,
    }));
  }

  /** Governance read-model feed: recorded run outcomes (the reliability surfaces). */
  governanceRuns(): GovernanceRunRow[] {
    return [...this.runs.values()].map((row) => ({
      runId: row.runId,
      threadId: row.threadId,
      actorRef: row.actorRef,
      status: row.status,
      retries: row.retries,
      startedAt: row.startedAt,
      ...(row.agentName !== undefined ? { agentName: row.agentName } : {}),
      ...(row.parentRunId !== undefined ? { parentRunId: row.parentRunId } : {}),
      ...(row.durationMs !== undefined ? { durationMs: row.durationMs } : {}),
      ...(row.errorCode !== undefined ? { errorCode: row.errorCode } : {}),
      ...(row.errorMessage !== undefined ? { errorMessage: row.errorMessage } : {}),
      ...(row.settledAt !== undefined ? { settledAt: row.settledAt } : {}),
      ...(row.promptHash !== undefined ? { promptHash: row.promptHash } : {}),
    }));
  }

  private threadIdForMessage(messageId: string): string | undefined {
    for (const [threadId, row] of this.threads) {
      if (row.messages.some((message) => message.id === messageId)) {
        return threadId;
      }
    }
    return undefined;
  }

  /** Test helper: read the recorded tool-call rows. */
  toolCallRows(): {
    toolCallId: string;
    toolName: string;
    toolType: 'read' | 'action';
    status: ToolCallStatus;
    input?: unknown;
    output?: unknown;
    error?: string;
    runId?: string;
    executedByRef?: string;
    approver?: string;
    expiresAt?: string;
    remember?: boolean;
    decidedVia?: string;
  }[] {
    return [...this.toolCalls.values()].map((row) => ({
      toolCallId: row.toolCallId,
      toolName: row.toolName,
      toolType: row.toolType,
      status: row.status,
      input: row.input,
      ...(row.output !== undefined ? { output: row.output } : {}),
      ...(row.error !== undefined ? { error: row.error } : {}),
      ...(row.runId !== undefined ? { runId: row.runId } : {}),
      ...(row.executedByRef !== undefined ? { executedByRef: row.executedByRef } : {}),
      ...(row.approver !== undefined ? { approver: row.approver } : {}),
      ...(row.expiresAt !== undefined ? { expiresAt: row.expiresAt } : {}),
      ...(row.remember !== undefined ? { remember: row.remember } : {}),
      ...(row.decidedVia !== undefined ? { decidedVia: row.decidedVia } : {}),
    }));
  }

  private toSummary(row: ThreadRow): ThreadSummary {
    const last = row.messages[row.messages.length - 1];
    return {
      id: row.id,
      title: row.title,
      transient: row.transient,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      ...(last !== undefined ? { lastMessagePreview: last.content.slice(0, 120) } : {}),
      defaultAgent: row.defaultAgent ?? null,
      ...(row.model != null ? { model: row.model } : {}),
    };
  }
}
