import {
  type AgentStore,
  type AgentUiComponent,
  type AppendMessageInput,
  type ChatQueueStore,
  type CreateThreadInput,
  type EnqueueMessageInput,
  type MessageFeedback,
  type QueuePause,
  type QueuedMessage,
  type QueuedMessagePatch,
  type RecordRunStartInput,
  type RecordToolCallInput,
  type RecordUsageInput,
  type StoredMessage,
  type ThreadDetail,
  type ThreadSummary,
  type ThreadTurnPage,
  type ThreadTurnQuery,
  type ThreadTurnReader,
  type ToolCallApproval,
  type ToolCallApprovalState,
  type ToolCallOutcome,
  type ToolResult,
  type UpdateThreadInput,
  type UpdateToolCallInput,
  toolCallApprovalFromRow,
} from '@dudousxd/nestjs-agent-core';
import { type EntityManager, QueryOrder, raw } from '@mikro-orm/core';
import { AgentMessage } from './entities/agent-message.entity';
import { AgentQueuedMessage } from './entities/agent-queued-message.entity';
import { AgentRun } from './entities/agent-run.entity';
import { AgentThread } from './entities/agent-thread.entity';
import { AgentTokenUsage } from './entities/agent-token-usage.entity';
import { AgentToolCall } from './entities/agent-tool-call.entity';
import { MESSAGE_ORDER, MESSAGE_ORDER_NEWEST_FIRST } from './message-order';

/**
 * Re-exported from the core SPI so a consumer can name this store's window read without importing a
 * second package. ONE definition of the shape, so the adapter and the seam the loop probes for
 * cannot drift apart.
 */
export type { ThreadTurnPage, ThreadTurnQuery };

/** The message columns a model turn reads. `usage`, `follow_ups` and `run_id` are nobody's business here. */
const TURN_MESSAGE_FIELDS = [
  'role',
  'content',
  'agentName',
  'toolCalls',
  'toolResults',
  'attachments',
  'createdAt',
] as const;

/** The columns present on EVERY message row this store reads, projected or not. */
type TurnMessageKey = 'id' | 'role' | 'content' | 'createdAt';

/**
 * A message row the mappers below accept: the columns every read of the table selects, and nothing
 * else required. A partial load carrying only {@link TURN_MESSAGE_FIELDS} satisfies it, and so does
 * a fully loaded {@link AgentMessage} — one mapper serves the window read and the transcript read.
 */
type TurnMessage = Pick<AgentMessage, TurnMessageKey> & {
  [K in Exclude<keyof AgentMessage, TurnMessageKey>]?: AgentMessage[K] | undefined;
};

/**
 * {@link AgentStore} backed by MikroORM. A POJO receiving an {@link EntityManager}; each
 * operation runs on a fresh `em.fork()` so per-request identity maps never bleed across
 * concurrent turns. Behaviour mirrors the in-memory reference store (fork/truncate/quota/
 * active-stream/soft-delete semantics) so the two are interchangeable in tests.
 */
export class MikroOrmAgentStore implements AgentStore, ThreadTurnReader, ChatQueueStore {
  constructor(private readonly em: EntityManager) {}

  async createThread(input: CreateThreadInput): Promise<ThreadSummary> {
    const em = this.em.fork();
    const now = new Date();
    const thread = em.create(AgentThread, {
      id: input.id ?? crypto.randomUUID(),
      actorRef: input.actor.id,
      title: input.title ?? 'New chat',
      transient: input.transient ?? false,
      createdAt: now,
      updatedAt: now,
      ...(input.actor.tenantRef !== undefined ? { tenantRef: input.actor.tenantRef } : {}),
      ...(input.persona !== undefined ? { persona: input.persona } : {}),
    });
    em.persist(thread);
    await em.flush();
    return this.toSummary(thread);
  }

  async getThread(threadId: string): Promise<ThreadDetail | null> {
    const em = this.em.fork();
    const thread = await em.findOne(AgentThread, { id: threadId, deletedAt: null });
    if (thread === null) {
      return null;
    }
    const messages = await em.find(AgentMessage, { thread }, { orderBy: MESSAGE_ORDER });
    // A message that carries tool calls and no results of its own is completed from the
    // `agent_tool_call` rows: an assistant message whose calls have no matching results makes the
    // NEXT turn throw MissingToolResultsError at the provider, and the rows are the only other
    // place an output survives.
    const resultsByMessage = await this.loadToolResults(em, messages);
    const approvals = await this.loadApprovals(
      em,
      messages.map((message) => message.id),
    );
    const last = messages[messages.length - 1];
    return {
      ...this.toSummary(thread, last?.content),
      messages: messages.map((message) => {
        const stored = this.toStoredMessage(message, resultsByMessage.get(message.id));
        const onMessage = approvals.get(message.id);
        return onMessage !== undefined ? { ...stored, approvals: onMessage } : stored;
      }),
      ...(thread.activeStreamId != null ? { activeRunId: thread.activeStreamId } : {}),
    };
  }

  /**
   * The window a turn reads off a thread: its newest `messageLimit` messages (oldest first), the
   * title, the default agent, and whether the thread has EVER been answered.
   *
   * {@link getThread} is the wrong read for a turn. It materializes the transcript — every message,
   * every attachment, every tool output the thread ever recorded — and the run then journals what it
   * loaded, so a long thread pays for its whole history on every turn and again on every replay.
   *
   * `hasAssistantMessage` is counted over the WHOLE thread, not the returned page: it answers "has
   * this conversation been answered before?", and a thread whose window happens to hold only the
   * user's last questions has still been answered. `null` when the thread is unknown or
   * soft-deleted, same as {@link getThread}.
   */
  async loadThreadForTurn(query: ThreadTurnQuery): Promise<ThreadTurnPage | null> {
    const em = this.em.fork();
    const thread = await em.findOne(
      AgentThread,
      { id: query.threadId, deletedAt: null },
      { fields: ['title', 'defaultAgent'] },
    );
    if (thread === null) {
      return null;
    }
    const messages = await this.loadTurnWindow(em, query.threadId, query.messageLimit);
    const resultsByMessage = await this.loadToolResults(em, messages);
    return {
      title: thread.title,
      defaultAgent: thread.defaultAgent ?? null,
      hasAssistantMessage:
        (await em.count(AgentMessage, { thread: query.threadId, role: 'assistant' })) > 0,
      messages: messages.map((message) =>
        this.toStoredMessage(message, resultsByMessage.get(message.id)),
      ),
    };
  }

  /**
   * The newest `limit` messages of a thread, oldest first, projected to the columns a model turn
   * reads. Read newest-first so the LIMIT is the database's job, then reversed for the prompt.
   */
  private async loadTurnWindow(
    em: EntityManager,
    threadId: string,
    limit: number | undefined,
  ): Promise<TurnMessage[]> {
    if (limit !== undefined && limit <= 0) {
      return [];
    }
    const messages = await em.find(
      AgentMessage,
      { thread: threadId },
      {
        fields: TURN_MESSAGE_FIELDS,
        orderBy: MESSAGE_ORDER_NEWEST_FIRST,
        ...(limit !== undefined ? { limit } : {}),
      },
    );
    return messages.reverse();
  }

  /**
   * Group the resolved tool calls of each message that has none of its own into `ToolResult[]`,
   * keyed by message id. A call is "resolved" once it has run (executed/failed/rejected) — a
   * pending-approval call has no result yet and is skipped, so a mid-approval turn doesn't inject
   * a phantom empty result.
   */
  private async loadToolResults(
    em: EntityManager,
    messages: TurnMessage[],
  ): Promise<Map<string, ToolResult[]>> {
    const awaitingResults = messages
      .filter((message) => message.toolCalls != null && message.toolResults == null)
      .map((message) => message.id);
    const byMessage = new Map<string, ToolResult[]>();
    if (awaitingResults.length === 0) {
      return byMessage;
    }
    const calls = await em.find(
      AgentToolCall,
      { message: { $in: awaitingResults }, status: { $ne: 'pending_approval' } },
      { orderBy: { createdAt: 'asc', id: 'asc' } },
    );
    for (const call of calls) {
      const messageId = call.message.id;
      const list = byMessage.get(messageId) ?? [];
      list.push({
        id: call.id,
        name: call.toolName,
        output: call.output ?? null,
        ...(call.error != null ? { error: call.error } : {}),
      });
      byMessage.set(messageId, list);
    }
    return byMessage;
  }

  /**
   * The approval record of every call on `messageIds` that a policy put to a person, grouped by
   * message. Only calls carrying an approver are read.
   */
  private async loadApprovals(
    em: EntityManager,
    messageIds: string[],
  ): Promise<Map<string, ToolCallApproval[]>> {
    const byMessage = new Map<string, ToolCallApproval[]>();
    if (messageIds.length === 0) {
      return byMessage;
    }
    const calls = await em.find(
      AgentToolCall,
      { message: { $in: messageIds }, approver: { $ne: null } },
      { orderBy: { createdAt: 'asc', id: 'asc' } },
    );
    for (const call of calls) {
      const approval = toolCallApprovalFromRow({
        toolCallId: call.id,
        status: call.status,
        approver: call.approver,
        confirmation: call.confirmation,
        expiresAt: call.expiresAt,
        remember: call.remember,
        executedByRef: call.executedByRef,
        decidedVia: call.decidedVia,
        error: call.error,
      });
      if (approval === null) {
        continue;
      }
      const list = byMessage.get(call.message.id) ?? [];
      list.push(approval);
      byMessage.set(call.message.id, list);
    }
    return byMessage;
  }

  /** Tools whose approval someone asked to remember in this thread. */
  async rememberedApprovals(threadId: string): Promise<string[]> {
    const em = this.em.fork();
    const calls = await em.find(
      AgentToolCall,
      { message: { thread: threadId }, remember: true },
      { fields: ['toolName'] },
    );
    return [...new Set(calls.map((call) => call.toolName))];
  }

  async toolCallInput(toolCallId: string): Promise<unknown> {
    const em = this.em.fork();
    const call = await em.findOne(AgentToolCall, { id: toolCallId }, { fields: ['input'] });
    return call?.input ?? null;
  }

  async toolCallApproval(toolCallId: string): Promise<ToolCallApprovalState | null> {
    const em = this.em.fork();
    const call = await em.findOne(AgentToolCall, { id: toolCallId });
    if (call === null) {
      return null;
    }
    return {
      status: call.status,
      approver: call.approver ?? null,
      expiresAt: call.expiresAt?.toISOString() ?? null,
    };
  }

  async listThreads(actorRef: string, limit = 50): Promise<ThreadSummary[]> {
    const em = this.em.fork();
    const threads = await em.find(
      AgentThread,
      { actorRef, transient: false, deletedAt: null },
      { orderBy: { updatedAt: 'desc' }, limit },
    );
    const summaries: ThreadSummary[] = [];
    for (const thread of threads) {
      const last = await em.findOne(
        AgentMessage,
        { thread },
        { orderBy: MESSAGE_ORDER_NEWEST_FIRST },
      );
      summaries.push(this.toSummary(thread, last?.content));
    }
    return summaries;
  }

  async softDeleteThread(threadId: string): Promise<void> {
    const em = this.em.fork();
    const thread = await em.findOne(AgentThread, { id: threadId });
    if (thread !== null) {
      thread.deletedAt = new Date();
      await em.flush();
    }
  }

  async forkThread(threadId: string, fromMessageId: string): Promise<ThreadSummary> {
    const em = this.em.fork();
    const source = await em.findOne(AgentThread, { id: threadId });
    if (source === null) {
      throw new Error(`thread ${threadId} not found`);
    }
    const messages = await em.find(AgentMessage, { thread: source }, { orderBy: MESSAGE_ORDER });
    const cutoff = messages.findIndex((message) => message.id === fromMessageId);
    const kept = cutoff >= 0 ? messages.slice(0, cutoff + 1) : messages;
    const now = new Date();
    const fork = em.create(AgentThread, {
      id: crypto.randomUUID(),
      actorRef: source.actorRef,
      title: source.title,
      transient: false,
      createdAt: now,
      updatedAt: now,
      ...(source.tenantRef != null ? { tenantRef: source.tenantRef } : {}),
      ...(source.defaultAgent != null ? { defaultAgent: source.defaultAgent } : {}),
      ...(source.model != null ? { model: source.model } : {}),
      ...(source.persona != null ? { persona: source.persona } : {}),
    });
    em.persist(fork);
    for (const [index, message] of kept.entries()) {
      em.persist(
        em.create(AgentMessage, {
          id: crypto.randomUUID(),
          thread: fork,
          role: message.role,
          content: message.content,
          // Numbered afresh in the order just read, so the copy reads back in the original's order.
          seq: index + 1,
          createdAt: message.createdAt,
          ...(message.toolCalls != null ? { toolCalls: message.toolCalls } : {}),
          ...(message.toolResults != null ? { toolResults: message.toolResults } : {}),
          ...(message.attachments != null ? { attachments: message.attachments } : {}),
          ...(message.followUps != null ? { followUps: message.followUps } : {}),
          ...(message.usage != null ? { usage: message.usage } : {}),
          ...(message.agentName != null ? { agentName: message.agentName } : {}),
          ...(message.persona != null ? { persona: message.persona } : {}),
          // The copy is the same message, so it keeps the run that wrote it. A reader asking which
          // turn produced this text gets the truthful answer; the run's own thread is still the
          // original, so a run-scoped read never picks the fork's rows up.
          ...(message.runId != null ? { runId: message.runId } : {}),
          ...(message.reasoning != null ? { reasoning: message.reasoning } : {}),
          ...(message.reasoningMs != null ? { reasoningMs: message.reasoningMs } : {}),
          ...(message.ui != null ? { ui: message.ui } : {}),
        }),
      );
    }
    await em.flush();
    return this.toSummary(fork);
  }

  async ownerOfThread(threadId: string): Promise<string | null> {
    const em = this.em.fork();
    const thread = await em.findOne(
      AgentThread,
      { id: threadId, deletedAt: null },
      { fields: ['actorRef'] },
    );
    return thread?.actorRef ?? null;
  }

  async ownerOfToolCall(toolCallId: string): Promise<string | null> {
    const em = this.em.fork();
    const toolCall = await em.findOne(
      AgentToolCall,
      { id: toolCallId },
      { populate: ['message.thread'] },
    );
    if (toolCall === null) {
      return null;
    }
    return toolCall.message.thread.actorRef;
  }

  async runForToolCall(toolCallId: string): Promise<string | null> {
    const em = this.em.fork();
    const toolCall = await em.findOne(
      AgentToolCall,
      { id: toolCallId },
      { populate: ['message.thread'] },
    );
    return toolCall?.runId ?? toolCall?.message.thread.activeStreamId ?? null;
  }

  async ownerOfActiveStream(runId: string): Promise<string | null> {
    const em = this.em.fork();
    const thread = await em.findOne(
      AgentThread,
      { activeStreamId: runId, deletedAt: null },
      { fields: ['actorRef'] },
    );
    return thread?.actorRef ?? null;
  }

  async setTitle(threadId: string, title: string): Promise<void> {
    const em = this.em.fork();
    const thread = await em.findOne(AgentThread, { id: threadId });
    if (thread !== null) {
      thread.title = title;
      thread.updatedAt = new Date();
      await em.flush();
    }
  }

  async promoteThread(threadId: string): Promise<void> {
    const em = this.em.fork();
    const thread = await em.findOne(AgentThread, { id: threadId });
    if (thread?.transient) {
      thread.transient = false;
      thread.updatedAt = new Date();
      await em.flush();
    }
  }

  /**
   * One conditional UPDATE, so of two racing claims exactly one changes the row: set the holder to
   * `runId` only when there is none, it is already `runId`, or it is `replacing`.
   */
  async claimActiveStream(
    threadId: string,
    runId: string,
    options: { replacing?: string } = {},
  ): Promise<boolean> {
    const em = this.em.fork();
    const holders: Array<{ activeStreamId: string | null }> = [
      { activeStreamId: null },
      { activeStreamId: runId },
      ...(options.replacing !== undefined ? [{ activeStreamId: options.replacing }] : []),
    ];
    const changed = await em.nativeUpdate(
      AgentThread,
      { id: threadId, $or: holders },
      { activeStreamId: runId },
    );
    if (changed > 0) {
      return true;
    }
    // Zero can still be a win: a MySQL connection without FOUND_ROWS reports CHANGED rows, and
    // re-claiming a thread this run already holds changes nothing. The row says who holds it now.
    const thread = await em.findOne(AgentThread, { id: threadId }, { fields: ['activeStreamId'] });
    return thread?.activeStreamId === runId;
  }

  async releaseActiveStream(threadId: string, runId: string): Promise<boolean> {
    const em = this.em.fork();
    const changed = await em.nativeUpdate(
      AgentThread,
      { id: threadId, activeStreamId: runId },
      { activeStreamId: null },
    );
    return changed > 0;
  }

  async enqueueMessage(input: EnqueueMessageInput): Promise<QueuedMessage> {
    const em = this.em.fork();
    const existing = await em.find(
      AgentQueuedMessage,
      { thread: input.threadId },
      { fields: ['position'], orderBy: { position: 'asc' } },
    );
    const first = existing[0]?.position;
    const last = existing[existing.length - 1]?.position;
    const now = new Date();
    const message = em.create(AgentQueuedMessage, {
      id: crypto.randomUUID(),
      thread: em.getReference(AgentThread, input.threadId),
      actor: input.actor,
      content: input.content,
      attachments:
        input.attachments !== undefined && input.attachments.length > 0 ? input.attachments : null,
      agentName: input.agentName ?? null,
      persona: input.persona ?? null,
      model: input.model ?? null,
      pageContext: input.pageContext ?? null,
      interrupt: input.interrupt === true,
      position: input.at === 'head' ? (first ?? 1) - 1 : (last ?? -1) + 1,
      createdAt: now,
      updatedAt: now,
    });
    em.persist(message);
    await em.flush();
    return this.toQueuedMessage(message, input.threadId);
  }

  async listQueue(threadId: string): Promise<QueuedMessage[]> {
    const em = this.em.fork();
    const rows = await em.find(
      AgentQueuedMessage,
      { thread: threadId },
      { orderBy: { position: 'asc', createdAt: 'asc' } },
    );
    return rows.map((row) => this.toQueuedMessage(row, threadId));
  }

  async getQueuedMessage(id: string): Promise<QueuedMessage | null> {
    const em = this.em.fork();
    const row = await em.findOne(AgentQueuedMessage, { id });
    return row === null ? null : this.toQueuedMessage(row, row.thread.id);
  }

  async updateQueuedMessage(id: string, patch: QueuedMessagePatch): Promise<QueuedMessage | null> {
    const em = this.em.fork();
    const row = await em.findOne(AgentQueuedMessage, { id });
    if (row === null) {
      return null;
    }
    if (patch.content !== undefined) {
      row.content = patch.content;
    }
    if (patch.attachments !== undefined) {
      row.attachments =
        patch.attachments === null || patch.attachments.length === 0 ? null : patch.attachments;
    }
    if (patch.interrupt !== undefined) {
      row.interrupt = patch.interrupt;
    }
    row.updatedAt = new Date();
    await em.flush();
    return this.toQueuedMessage(row, row.thread.id);
  }

  /** Rewrites the thread's positions as 0..n-1 in the new order — a queue is a handful of rows. */
  async moveQueuedMessage(id: string, index: number): Promise<boolean> {
    const em = this.em.fork();
    const moving = await em.findOne(AgentQueuedMessage, { id });
    if (moving === null) {
      return false;
    }
    const order = (
      await em.find(
        AgentQueuedMessage,
        { thread: moving.thread.id },
        { orderBy: { position: 'asc', createdAt: 'asc' } },
      )
    ).filter((row) => row.id !== id);
    const target = Math.max(0, Math.min(order.length, Math.trunc(index)));
    order.splice(target, 0, moving);
    for (const [position, row] of order.entries()) {
      row.position = position;
    }
    await em.flush();
    return true;
  }

  async removeQueuedMessage(id: string): Promise<boolean> {
    const em = this.em.fork();
    return (await em.nativeDelete(AgentQueuedMessage, { id })) > 0;
  }

  async clearQueue(threadId: string): Promise<number> {
    const em = this.em.fork();
    return em.nativeDelete(AgentQueuedMessage, { thread: threadId });
  }

  async queuePause(threadId: string): Promise<QueuePause | null> {
    const em = this.em.fork();
    const thread = await em.findOne(AgentThread, { id: threadId }, { fields: ['queuePause'] });
    return thread?.queuePause ?? null;
  }

  async setQueuePause(threadId: string, pause: QueuePause | null): Promise<void> {
    const em = this.em.fork();
    const thread = await em.findOne(AgentThread, { id: threadId });
    if (thread !== null) {
      thread.queuePause = pause;
      await em.flush();
    }
  }

  private toQueuedMessage(row: AgentQueuedMessage, threadId: string): QueuedMessage {
    return {
      id: row.id,
      threadId,
      actor: row.actor,
      content: row.content,
      ...(row.attachments != null && row.attachments.length > 0
        ? { attachments: row.attachments }
        : {}),
      ...(row.agentName != null ? { agentName: row.agentName } : {}),
      ...(row.persona != null ? { persona: row.persona } : {}),
      ...(row.model != null ? { model: row.model } : {}),
      ...(row.pageContext != null ? { pageContext: row.pageContext } : {}),
      ...(row.interrupt ? { interrupt: true } : {}),
      createdAt: new Date(row.createdAt).toISOString(),
      updatedAt: new Date(row.updatedAt).toISOString(),
    };
  }

  async setActiveStream(threadId: string, runId: string | null): Promise<void> {
    const em = this.em.fork();
    const thread = await em.findOne(AgentThread, { id: threadId });
    if (thread !== null) {
      thread.activeStreamId = runId;
      await em.flush();
    }
  }

  /**
   * Patch a thread's `title` and/or `defaultAgent`. Each field is only touched when PRESENT in
   * `patch` — `defaultAgent: null` clears it (falls back to the app default), while an omitted
   * `defaultAgent` leaves whatever is stored untouched. A no-op (including `updatedAt`) when the
   * thread doesn't exist or the patch is empty.
   */
  async updateThread(threadId: string, patch: UpdateThreadInput): Promise<void> {
    const em = this.em.fork();
    const thread = await em.findOne(AgentThread, { id: threadId });
    if (thread === null) {
      return;
    }
    let touched = false;
    if (patch.title !== undefined) {
      thread.title = patch.title;
      touched = true;
    }
    if (patch.defaultAgent !== undefined) {
      thread.defaultAgent = patch.defaultAgent;
      touched = true;
    }
    if (patch.model !== undefined) {
      thread.model = patch.model;
      touched = true;
    }
    if (patch.persona !== undefined) {
      thread.persona = patch.persona;
      touched = true;
    }
    if (touched) {
      thread.updatedAt = new Date();
      await em.flush();
    }
  }

  /**
   * The thread's default agent, projected — the caller wants one nullable scalar to decide which
   * agent answers the next turn, and {@link getThread} would materialize the whole transcript (every
   * message, every tool output) to hand it over. `null` when the thread is unknown, soft-deleted, or
   * has no default set.
   */
  /** The thread's pinned model, projected like {@link defaultAgentForThread}. */
  async modelForThread(threadId: string): Promise<string | null> {
    const em = this.em.fork();
    const thread = await em.findOne(
      AgentThread,
      { id: threadId, deletedAt: null },
      { fields: ['model'] },
    );
    return thread?.model ?? null;
  }

  /** The thread's pinned persona, projected like {@link defaultAgentForThread}. */
  async personaForThread(threadId: string): Promise<string | null> {
    const em = this.em.fork();
    const thread = await em.findOne(
      AgentThread,
      { id: threadId, deletedAt: null },
      { fields: ['persona'] },
    );
    return thread?.persona ?? null;
  }

  async defaultAgentForThread(threadId: string): Promise<string | null> {
    const em = this.em.fork();
    const thread = await em.findOne(
      AgentThread,
      { id: threadId, deletedAt: null },
      { fields: ['defaultAgent'] },
    );
    return thread?.defaultAgent ?? null;
  }

  /**
   * The runId currently streaming this thread (its `activeStreamId`), or `null` if the thread is
   * unknown, soft-deleted, or has no active run. This is the same field {@link setActiveStream} writes
   * and {@link ownerOfActiveStream}/{@link runForToolCall} already read by runId — this is the reverse
   * lookup, keyed by threadId.
   */
  async activeRunForThread(threadId: string): Promise<string | null> {
    const em = this.em.fork();
    const thread = await em.findOne(
      AgentThread,
      { id: threadId, deletedAt: null },
      { fields: ['activeStreamId'] },
    );
    return thread?.activeStreamId ?? null;
  }

  /**
   * Persist the start of a run (turn). Replay-safe: called under a durable localStep.
   *
   * Takes the SPI's own {@link RecordRunStartInput} rather than a hand-copied shape: a field added
   * to the input is otherwise accepted and dropped, silently, by every adapter that re-declares it.
   */
  async recordRunStart(run: RecordRunStartInput): Promise<void> {
    const em = this.em.fork();
    const runRow = em.create(AgentRun, {
      id: run.runId,
      thread: em.getReference(AgentThread, run.threadId),
      actorRef: run.actorRef,
      status: 'running',
      retries: 0,
      startedAt: new Date(),
      ...(run.agentName !== undefined ? { agentName: run.agentName } : {}),
      ...(run.parentRunId !== undefined ? { parentRunId: run.parentRunId } : {}),
      ...(run.promptHash !== undefined ? { promptHash: run.promptHash } : {}),
    });
    em.persist(runRow);
    await em.flush();
  }

  /** Settle a run's outcome. A no-op when the run is unknown (mirrors `setTitle`/`updateThread`). */
  async recordRunEnd(end: {
    runId: string;
    status: 'completed' | 'failed' | 'cancelled';
    durationMs?: number;
    errorCode?: string;
    errorMessage?: string;
  }): Promise<void> {
    const em = this.em.fork();
    const runRow = await em.findOne(AgentRun, { id: end.runId });
    if (runRow === null) {
      return;
    }
    runRow.status = end.status;
    runRow.settledAt = new Date();
    if (end.durationMs !== undefined) {
      runRow.durationMs = end.durationMs;
    }
    if (end.errorCode !== undefined) {
      runRow.errorCode = end.errorCode;
    }
    if (end.errorMessage !== undefined) {
      runRow.errorMessage = end.errorMessage;
    }
    await em.flush();
  }

  /** Bump the run's llm-step retry counter. Atomic `retries = retries + 1`, no read-modify-write. */
  async bumpRunRetries(runId: string): Promise<void> {
    const em = this.em.fork();
    await em.nativeUpdate(AgentRun, { id: runId }, { retries: raw<number>('retries + 1') });
  }

  async appendMessage(input: AppendMessageInput): Promise<StoredMessage> {
    const em = this.em.fork();
    const thread = await em.findOne(AgentThread, { id: input.threadId });
    if (thread === null) {
      throw new Error(`thread ${input.threadId} not found`);
    }
    const now = new Date();
    const message = em.create(AgentMessage, {
      id: crypto.randomUUID(),
      thread,
      role: input.role,
      content: input.content,
      seq: await this.nextMessageSeq(em, thread.id),
      createdAt: now,
      ...(input.toolCalls !== undefined ? { toolCalls: input.toolCalls } : {}),
      ...(input.toolResults !== undefined ? { toolResults: input.toolResults } : {}),
      ...(input.attachments !== undefined ? { attachments: input.attachments } : {}),
      ...(input.followUps !== undefined ? { followUps: input.followUps } : {}),
      ...(input.usage !== undefined ? { usage: input.usage } : {}),
      ...(input.agentName !== undefined ? { agentName: input.agentName } : {}),
      ...(input.persona !== undefined ? { persona: input.persona } : {}),
      ...(input.runId !== undefined ? { runId: input.runId } : {}),
      ...(input.reasoning !== undefined ? { reasoning: input.reasoning } : {}),
      ...(input.reasoningMs !== undefined ? { reasoningMs: input.reasoningMs } : {}),
      ...(input.ui !== undefined ? { ui: input.ui } : {}),
    });
    thread.updatedAt = now;
    em.persist(message);
    await em.flush();
    return this.toStoredMessage(message);
  }

  /**
   * The next `seq` in a thread: one past its highest. Two appends racing on ONE thread can draw the
   * same number — the turn loop never does that, and the tie then falls back to `created_at`, `id`.
   */
  private async nextMessageSeq(em: EntityManager, threadId: string): Promise<number> {
    const [last] = await em.find(
      AgentMessage,
      { thread: threadId, seq: { $ne: null } },
      { fields: ['seq'], orderBy: { seq: QueryOrder.DESC }, limit: 1 },
    );
    return (last?.seq ?? 0) + 1;
  }

  async setMessageUi(messageId: string, ui: AgentUiComponent[]): Promise<void> {
    const em = this.em.fork();
    const message = await em.findOne(AgentMessage, { id: messageId });
    if (message === null) {
      return;
    }
    message.ui = ui.length > 0 ? ui : null;
    await em.flush();
  }

  async threadOfMessage(messageId: string): Promise<string | null> {
    const em = this.em.fork();
    const message = await em.findOne(AgentMessage, { id: messageId }, { fields: ['thread'] });
    return message?.thread.id ?? null;
  }

  async setMessageFeedback(messageId: string, feedback: MessageFeedback | null): Promise<void> {
    const em = this.em.fork();
    const message = await em.findOne(AgentMessage, { id: messageId });
    if (message === null) {
      return;
    }
    message.feedback = feedback;
    await em.flush();
  }

  async setMessageToolResults(messageId: string, results: ToolResult[]): Promise<void> {
    const em = this.em.fork();
    const message = await em.findOne(AgentMessage, { id: messageId });
    if (message === null) {
      return;
    }
    message.toolResults = results;
    await em.flush();
  }

  async truncateFrom(threadId: string, messageId: string): Promise<void> {
    const em = this.em.fork();
    const thread = await em.findOne(AgentThread, { id: threadId });
    if (thread === null) {
      return;
    }
    const messages = await em.find(AgentMessage, { thread }, { orderBy: MESSAGE_ORDER });
    const cutoff = messages.findIndex((message) => message.id === messageId);
    if (cutoff < 0) {
      return;
    }
    const doomedIds = messages.slice(cutoff).map((message) => message.id);
    await em.nativeDelete(AgentToolCall, { message: { $in: doomedIds } });
    await em.nativeDelete(AgentMessage, { id: { $in: doomedIds } });
  }

  async recordToolCall(input: RecordToolCallInput): Promise<void> {
    const em = this.em.fork();
    const toolCall = em.create(AgentToolCall, {
      id: input.toolCallId,
      message: em.getReference(AgentMessage, input.messageId),
      toolName: input.toolName,
      toolType: input.toolType,
      input: input.input,
      status: input.status,
      createdAt: new Date(),
      runId: input.runId ?? null,
      approver: input.approver ?? null,
      confirmation: input.confirmation ?? null,
      expiresAt: input.expiresAt !== undefined ? new Date(input.expiresAt) : null,
    });
    em.persist(toolCall);
    await em.flush();
  }

  async updateToolCall(input: UpdateToolCallInput): Promise<void> {
    const em = this.em.fork();
    const toolCall = await em.findOne(AgentToolCall, { id: input.toolCallId });
    if (toolCall === null) {
      return;
    }
    toolCall.status = input.status;
    if (input.output !== undefined) {
      toolCall.output = input.output;
    }
    if (input.error !== undefined) {
      toolCall.error = input.error;
    }
    if (input.executionMs !== undefined) {
      toolCall.executionMs = input.executionMs;
    }
    if (input.executedByRef !== undefined) {
      toolCall.executedByRef = input.executedByRef;
    }
    if (input.remember !== undefined) {
      toolCall.remember = input.remember;
    }
    if (input.decidedVia !== undefined) {
      toolCall.decidedVia = input.decidedVia;
    }
    if (input.status === 'executed' || input.status === 'auto_executed') {
      toolCall.executedAt = new Date();
    }
    await em.flush();
  }

  async toolCallOutcomes(toolCallIds: readonly string[]): Promise<ToolCallOutcome[]> {
    if (toolCallIds.length === 0) {
      return [];
    }
    const em = this.em.fork();
    const calls = await em.find(
      AgentToolCall,
      { id: { $in: [...toolCallIds] } },
      { fields: ['id', 'status', 'output', 'error'] },
    );
    return calls.map((call) => ({
      id: call.id,
      status: call.status,
      ...(call.output !== undefined && call.output !== null ? { output: call.output } : {}),
      ...(typeof call.error === 'string' ? { error: call.error } : {}),
    }));
  }

  async failUnsettledToolCalls(runId: string, error: string): Promise<number> {
    const em = this.em.fork();
    return em.nativeUpdate(
      AgentToolCall,
      { runId, status: 'pending_approval' },
      { status: 'failed', error },
    );
  }

  /**
   * Of `mediaIds`, the ones a surviving message — or a message waiting in the queue — in one of
   * this actor's threads still carries.
   *
   * Reads the `attachments` JSON back out and matches in memory rather than pushing the match into
   * SQL: the column holds an array of objects, and each dialect this adapter supports spells that
   * query differently (`jsonb` containment, `json_table`, `json_each`), while none of them can use
   * an index for it anyway. The scan is bounded by ONE actor's attachment-bearing messages, which
   * is a small set — attachments are rare, and a message without one never leaves the database.
   *
   * Soft-deleted threads are deliberately included: their message rows survive, so the bytes they
   * point at are still reachable from stored state and are not garbage.
   */
  async referencedMediaIds(actorRef: string, mediaIds: readonly string[]): Promise<string[]> {
    if (mediaIds.length === 0) {
      return [];
    }
    const em = this.em.fork();
    const messages = await em.find(
      AgentMessage,
      { thread: { actorRef }, attachments: { $ne: null } },
      { fields: ['attachments'] },
    );
    // A message waiting in a thread's queue has been sent and not yet run: what it carries is in use.
    const queued = await em.find(
      AgentQueuedMessage,
      { thread: { actorRef }, attachments: { $ne: null } },
      { fields: ['attachments'] },
    );
    const wanted = new Set(mediaIds);
    const found = new Set<string>();
    for (const message of [...messages, ...queued]) {
      for (const attachment of message.attachments ?? []) {
        if (wanted.has(attachment.mediaId)) {
          found.add(attachment.mediaId);
        }
      }
    }
    return [...wanted].filter((mediaId) => found.has(mediaId));
  }

  async recordUsage(input: RecordUsageInput): Promise<void> {
    const em = this.em.fork();
    const usage = em.create(AgentTokenUsage, {
      id: crypto.randomUUID(),
      thread: em.getReference(AgentThread, input.threadId),
      actorRef: input.actorRef,
      modelId: input.modelId,
      purpose: input.purpose,
      inputTokens: input.usage.inputTokens,
      outputTokens: input.usage.outputTokens,
      createdAt: new Date(),
      ...(input.messageId !== undefined ? { messageId: input.messageId } : {}),
      ...(input.usage.cacheWriteTokens !== undefined
        ? { cacheWriteTokens: input.usage.cacheWriteTokens }
        : {}),
      ...(input.usage.cacheReadTokens !== undefined
        ? { cacheReadTokens: input.usage.cacheReadTokens }
        : {}),
      ...(input.costUsd !== undefined ? { costUsd: input.costUsd } : {}),
    });
    em.persist(usage);
    await em.flush();
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
    const em = this.em.fork();
    const start = new Date(`${fromDay}T00:00:00.000Z`);
    const end = new Date(`${toDay}T23:59:59.999Z`);
    const rows = await em.find(AgentTokenUsage, {
      actorRef,
      createdAt: { $gte: start, $lte: end },
    });
    const usedTokens = rows.reduce((sum, row) => sum + row.inputTokens + row.outputTokens, 0);
    const costUsd = rows.reduce((sum, row) => sum + (row.costUsd ?? 0), 0);
    return { usedTokens, costUsd };
  }

  private toSummary(thread: AgentThread, lastContent?: string): ThreadSummary {
    return {
      id: thread.id,
      title: thread.title,
      transient: thread.transient,
      createdAt: thread.createdAt.toISOString(),
      updatedAt: thread.updatedAt.toISOString(),
      defaultAgent: thread.defaultAgent ?? null,
      ...(thread.model != null ? { model: thread.model } : {}),
      persona: thread.persona ?? null,
      ...(lastContent !== undefined ? { lastMessagePreview: lastContent.slice(0, 120) } : {}),
    };
  }

  private toStoredMessage(message: TurnMessage, toolResults?: ToolResult[]): StoredMessage {
    // The message's own results are the answer — the same list every other adapter returns. The
    // rebuilt ones only ever arrive for a message that has none.
    const resolvedResults =
      message.toolResults ??
      (toolResults !== undefined && toolResults.length > 0 ? toolResults : undefined);
    return {
      id: message.id,
      role: message.role,
      content: message.content,
      createdAt: message.createdAt.toISOString(),
      ...(message.agentName != null ? { agentName: message.agentName } : {}),
      ...(message.persona != null ? { persona: message.persona } : {}),
      ...(message.toolCalls != null ? { toolCalls: message.toolCalls } : {}),
      ...(resolvedResults != null ? { toolResults: resolvedResults } : {}),
      ...(message.attachments != null ? { attachments: message.attachments } : {}),
      ...(message.followUps != null ? { followUps: message.followUps } : {}),
      ...(message.usage != null ? { usage: message.usage } : {}),
      ...(message.runId != null ? { runId: message.runId } : {}),
      ...(message.reasoning != null ? { reasoning: message.reasoning } : {}),
      ...(message.reasoningMs != null ? { reasoningMs: message.reasoningMs } : {}),
      ...(message.ui != null ? { ui: message.ui } : {}),
      ...(message.feedback != null ? { feedback: message.feedback } : {}),
    };
  }
}
