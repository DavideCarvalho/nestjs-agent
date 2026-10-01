import {
  type ActionProposalDiscoveryIndexStore,
  type ActionProposalStore,
  type ActionProposalStoreOptions,
  type ActionProposalWorkerStore,
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
import {
  type SQL,
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  max,
  min,
  or,
  sql,
} from 'drizzle-orm';
import {
  type AgentDialect,
  type AgentDrizzleDb,
  type AgentSqliteDb,
  type AgentTables,
  affectedRows,
  agentDialectOf,
  agentTablesFor,
  asBuilder,
} from './dialect.js';
import { DrizzleActionProposalStore } from './drizzle-action-proposal-store.js';
import {
  type AgentMessageRow,
  type AgentQueuedMessageRow,
  type AgentRunRow,
  type AgentThreadRow,
  agentMessage,
  agentQueuedMessage,
  agentRun,
  agentThread,
  agentTokenUsage,
  agentToolCall,
} from './schema.js';

/**
 * Re-exported from the core SPI so a consumer can name this store's window read without importing a
 * second package. ONE definition of the shape, so the adapter and the seam the loop probes for
 * cannot drift apart.
 */
export type { ThreadTurnPage, ThreadTurnQuery };

/** The message columns a model turn reads. `usage`, `follow_ups` and `run_id` are nobody's business here. */
function turnMessageColumns(message: AgentTables['agentMessage']) {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    agentName: message.agentName,
    toolCalls: message.toolCalls,
    toolResults: message.toolResults,
    attachments: message.attachments,
    createdAt: message.createdAt,
  };
}

type TurnMessageRow = { [K in keyof ReturnType<typeof turnMessageColumns>]: AgentMessageRow[K] };

/**
 * {@link AgentStore} backed by Drizzle ORM — a second adapter alongside the MikroORM one, proving
 * the store SPI is ORM-portable. A POJO receiving a Drizzle SQLite database handle (the host app
 * owns the connection). Behaviour mirrors {@link import('@dudousxd/nestjs-agent-store-mikro-orm')}
 * exactly (fork/truncate/quota/active-stream/soft-delete semantics) so the two are interchangeable.
 */
export class DrizzleAgentStore
  implements
    AgentStore,
    ThreadTurnReader,
    ChatQueueStore,
    ActionProposalStore,
    ActionProposalWorkerStore,
    ActionProposalDiscoveryIndexStore
{
  private readonly db: AgentSqliteDb;
  private readonly dialect: AgentDialect;
  private readonly t: AgentTables;

  private readonly proposals: DrizzleActionProposalStore;

  constructor(db: AgentDrizzleDb, options: ActionProposalStoreOptions = {}) {
    this.proposals = new DrizzleActionProposalStore(db, options);
    this.dialect = agentDialectOf(db);
    this.t = agentTablesFor(this.dialect);
    this.db = asBuilder(db);
  }

  createActionProposal(
    ...args: Parameters<ActionProposalStore['createActionProposal']>
  ): ReturnType<ActionProposalStore['createActionProposal']> {
    return this.proposals.createActionProposal(...args);
  }

  getActionProposal(
    ...args: Parameters<ActionProposalStore['getActionProposal']>
  ): ReturnType<ActionProposalStore['getActionProposal']> {
    return this.proposals.getActionProposal(...args);
  }

  listActionProposals(
    ...args: Parameters<ActionProposalStore['listActionProposals']>
  ): ReturnType<ActionProposalStore['listActionProposals']> {
    return this.proposals.listActionProposals(...args);
  }

  decideActionProposal(
    ...args: Parameters<ActionProposalStore['decideActionProposal']>
  ): ReturnType<ActionProposalStore['decideActionProposal']> {
    return this.proposals.decideActionProposal(...args);
  }

  claimActionProposal(
    ...args: Parameters<ActionProposalStore['claimActionProposal']>
  ): ReturnType<ActionProposalStore['claimActionProposal']> {
    return this.proposals.claimActionProposal(...args);
  }

  extendActionProposalLease(
    ...args: Parameters<ActionProposalStore['extendActionProposalLease']>
  ): ReturnType<ActionProposalStore['extendActionProposalLease']> {
    return this.proposals.extendActionProposalLease(...args);
  }

  claimNextActionProposal(
    ...args: Parameters<ActionProposalWorkerStore['claimNextActionProposal']>
  ): ReturnType<ActionProposalWorkerStore['claimNextActionProposal']> {
    return this.proposals.claimNextActionProposal(...args);
  }

  expireActionProposals(
    ...args: Parameters<ActionProposalWorkerStore['expireActionProposals']>
  ): ReturnType<ActionProposalWorkerStore['expireActionProposals']> {
    return this.proposals.expireActionProposals(...args);
  }

  backfillActionProposalDiscoveryIndex(command: { limit: number }): Promise<number> {
    return this.proposals.backfillActionProposalDiscoveryIndex(command);
  }

  settleActionProposal(
    ...args: Parameters<ActionProposalStore['settleActionProposal']>
  ): ReturnType<ActionProposalStore['settleActionProposal']> {
    return this.proposals.settleActionProposal(...args);
  }

  async createThread(input: CreateThreadInput): Promise<ThreadSummary> {
    const now = new Date();
    const thread: AgentThreadRow = {
      id: input.id ?? crypto.randomUUID(),
      actorRef: input.actor.id,
      tenantRef: input.actor.tenantRef ?? null,
      title: input.title ?? 'New chat',
      transient: input.transient ?? false,
      activeStreamId: null,
      defaultAgent: null,
      model: null,
      persona: input.persona ?? null,
      queuePause: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    await this.db.insert(this.t.agentThread).values(thread);
    return this.toSummary(thread);
  }

  async getThread(threadId: string): Promise<ThreadDetail | null> {
    const [thread] = await this.db
      .select()
      .from(this.t.agentThread)
      .where(and(eq(this.t.agentThread.id, threadId), isNull(this.t.agentThread.deletedAt)));
    if (thread === undefined) {
      return null;
    }
    const messages = await this.db
      .select()
      .from(this.t.agentMessage)
      .where(eq(this.t.agentMessage.threadId, threadId))
      .orderBy(...this.messageOrder());
    const last = messages[messages.length - 1];
    const approvals = await this.approvalsFor(messages.map((message) => message.id));
    return {
      ...this.toSummary(thread, last?.content),
      messages: messages.map((message) => {
        const stored = this.toStoredMessage(message);
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
   * `hasAssistantMessage` is answered over the WHOLE thread, not the returned page: it answers "has
   * this conversation been answered before?", and a thread whose window happens to hold only the
   * user's last questions has still been answered. `null` when the thread is unknown or
   * soft-deleted, same as {@link getThread}.
   */
  async loadThreadForTurn(query: ThreadTurnQuery): Promise<ThreadTurnPage | null> {
    const [thread] = await this.db
      .select({ title: this.t.agentThread.title, defaultAgent: this.t.agentThread.defaultAgent })
      .from(this.t.agentThread)
      .where(and(eq(this.t.agentThread.id, query.threadId), isNull(this.t.agentThread.deletedAt)));
    if (thread === undefined) {
      return null;
    }
    const messages = await this.loadTurnWindow(query.threadId, query.messageLimit);
    const [answered] = await this.db
      .select({ id: this.t.agentMessage.id })
      .from(this.t.agentMessage)
      .where(
        and(
          eq(this.t.agentMessage.threadId, query.threadId),
          eq(this.t.agentMessage.role, 'assistant'),
        ),
      )
      .limit(1);
    return {
      title: thread.title,
      defaultAgent: thread.defaultAgent,
      hasAssistantMessage: answered !== undefined,
      messages,
    };
  }

  /**
   * The newest `limit` messages of a thread, oldest first, projected to the columns a model turn
   * reads. Read newest-first so the LIMIT is the database's job, then reversed for the prompt.
   */
  private async loadTurnWindow(
    threadId: string,
    limit: number | undefined,
  ): Promise<StoredMessage[]> {
    if (limit !== undefined && limit <= 0) {
      return [];
    }
    const window = this.db
      .select(turnMessageColumns(this.t.agentMessage))
      .from(this.t.agentMessage)
      .where(eq(this.t.agentMessage.threadId, threadId))
      .orderBy(...this.messageOrderNewestFirst());
    const rows: TurnMessageRow[] = limit === undefined ? await window : await window.limit(limit);
    return rows.reverse().map((row) => this.toStoredMessage(row));
  }

  async listThreads(actorRef: string, limit = 50): Promise<ThreadSummary[]> {
    const threads = await this.db
      .select()
      .from(this.t.agentThread)
      .where(
        and(
          eq(this.t.agentThread.actorRef, actorRef),
          eq(this.t.agentThread.transient, false),
          isNull(this.t.agentThread.deletedAt),
        ),
      )
      .orderBy(desc(this.t.agentThread.updatedAt))
      .limit(limit);
    const summaries: ThreadSummary[] = [];
    for (const thread of threads) {
      const [last] = await this.db
        .select()
        .from(this.t.agentMessage)
        .where(eq(this.t.agentMessage.threadId, thread.id))
        .orderBy(...this.messageOrderNewestFirst())
        .limit(1);
      summaries.push(this.toSummary(thread, last?.content));
    }
    return summaries;
  }

  async softDeleteThread(threadId: string): Promise<void> {
    await this.db
      .update(this.t.agentThread)
      .set({ deletedAt: new Date() })
      .where(eq(this.t.agentThread.id, threadId));
  }

  async forkThread(threadId: string, fromMessageId: string): Promise<ThreadSummary> {
    const [source] = await this.db
      .select()
      .from(this.t.agentThread)
      .where(eq(this.t.agentThread.id, threadId));
    if (source === undefined) {
      throw new Error(`thread ${threadId} not found`);
    }
    const messages = await this.db
      .select()
      .from(this.t.agentMessage)
      .where(eq(this.t.agentMessage.threadId, threadId))
      .orderBy(...this.messageOrder());
    const cutoff = messages.findIndex((message) => message.id === fromMessageId);
    const kept = cutoff >= 0 ? messages.slice(0, cutoff + 1) : messages;
    const now = new Date();
    const fork: AgentThreadRow = {
      id: crypto.randomUUID(),
      actorRef: source.actorRef,
      tenantRef: source.tenantRef,
      title: source.title,
      transient: false,
      activeStreamId: null,
      defaultAgent: source.defaultAgent,
      model: source.model,
      persona: source.persona,
      // A fork is a new conversation: nothing is waiting on it, and nothing is paused.
      queuePause: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    await this.db.insert(this.t.agentThread).values(fork);
    if (kept.length > 0) {
      await this.db.insert(this.t.agentMessage).values(
        kept.map((message, index) => ({
          id: crypto.randomUUID(),
          // Numbered afresh in the order just read, so the copy reads back in the original's order.
          seq: index + 1,
          threadId: fork.id,
          role: message.role,
          content: message.content,
          toolCalls: message.toolCalls,
          toolResults: message.toolResults,
          attachments: message.attachments,
          followUps: message.followUps,
          usage: message.usage,
          agentName: message.agentName,
          persona: message.persona,
          // The copy is the same message, so it keeps the run that wrote it. A reader asking which
          // turn produced this text gets the truthful answer; the run's own thread is still the
          // original, so a run-scoped read never picks the fork's rows up.
          runId: message.runId,
          reasoning: message.reasoning,
          reasoningMs: message.reasoningMs,
          ui: message.ui,
          createdAt: message.createdAt,
        })),
      );
    }
    return this.toSummary(fork);
  }

  async ownerOfThread(threadId: string): Promise<string | null> {
    const [thread] = await this.db
      .select({ actorRef: this.t.agentThread.actorRef })
      .from(this.t.agentThread)
      .where(and(eq(this.t.agentThread.id, threadId), isNull(this.t.agentThread.deletedAt)));
    return thread?.actorRef ?? null;
  }

  async ownerOfToolCall(toolCallId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ actorRef: this.t.agentThread.actorRef })
      .from(this.t.agentToolCall)
      .innerJoin(this.t.agentMessage, eq(this.t.agentToolCall.messageId, this.t.agentMessage.id))
      .innerJoin(this.t.agentThread, eq(this.t.agentMessage.threadId, this.t.agentThread.id))
      .where(eq(this.t.agentToolCall.id, toolCallId));
    return row?.actorRef ?? null;
  }

  async runForToolCall(toolCallId: string): Promise<string | null> {
    const [row] = await this.db
      .select({
        runId: this.t.agentToolCall.runId,
        activeStreamId: this.t.agentThread.activeStreamId,
      })
      .from(this.t.agentToolCall)
      .innerJoin(this.t.agentMessage, eq(this.t.agentToolCall.messageId, this.t.agentMessage.id))
      .innerJoin(this.t.agentThread, eq(this.t.agentMessage.threadId, this.t.agentThread.id))
      .where(eq(this.t.agentToolCall.id, toolCallId));
    return row?.runId ?? row?.activeStreamId ?? null;
  }

  /**
   * The approval record of every call on `messageIds` that a policy put to a person, grouped by
   * message. One query over the calls that carry an approver — a thread whose calls never asked
   * anyone reads nothing back.
   */
  private async approvalsFor(messageIds: string[]): Promise<Map<string, ToolCallApproval[]>> {
    const byMessage = new Map<string, ToolCallApproval[]>();
    if (messageIds.length === 0) {
      return byMessage;
    }
    const rows = await this.db
      .select({
        id: this.t.agentToolCall.id,
        messageId: this.t.agentToolCall.messageId,
        status: this.t.agentToolCall.status,
        approver: this.t.agentToolCall.approver,
        confirmation: this.t.agentToolCall.confirmation,
        expiresAt: this.t.agentToolCall.expiresAt,
        remember: this.t.agentToolCall.remember,
        executedByRef: this.t.agentToolCall.executedByRef,
        decidedVia: this.t.agentToolCall.decidedVia,
        error: this.t.agentToolCall.error,
      })
      .from(this.t.agentToolCall)
      .where(
        and(
          inArray(this.t.agentToolCall.messageId, messageIds),
          isNotNull(this.t.agentToolCall.approver),
        ),
      )
      .orderBy(asc(this.t.agentToolCall.createdAt), asc(this.t.agentToolCall.id));
    for (const row of rows) {
      const approval = toolCallApprovalFromRow({ ...row, toolCallId: row.id });
      if (approval === null) {
        continue;
      }
      const list = byMessage.get(row.messageId) ?? [];
      list.push(approval);
      byMessage.set(row.messageId, list);
    }
    return byMessage;
  }

  /** Tools whose approval someone asked to remember in this thread. */
  async rememberedApprovals(threadId: string): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ toolName: this.t.agentToolCall.toolName })
      .from(this.t.agentToolCall)
      .innerJoin(this.t.agentMessage, eq(this.t.agentToolCall.messageId, this.t.agentMessage.id))
      .where(
        and(eq(this.t.agentMessage.threadId, threadId), eq(this.t.agentToolCall.remember, true)),
      );
    return rows.map((row) => row.toolName);
  }

  async toolCallInput(toolCallId: string): Promise<unknown> {
    const [row] = await this.db
      .select({ input: this.t.agentToolCall.input })
      .from(this.t.agentToolCall)
      .where(eq(this.t.agentToolCall.id, toolCallId));
    return row?.input ?? null;
  }

  async toolCallApproval(toolCallId: string): Promise<ToolCallApprovalState | null> {
    const [row] = await this.db
      .select({
        status: this.t.agentToolCall.status,
        approver: this.t.agentToolCall.approver,
        expiresAt: this.t.agentToolCall.expiresAt,
      })
      .from(this.t.agentToolCall)
      .where(eq(this.t.agentToolCall.id, toolCallId));
    if (row === undefined) {
      return null;
    }
    return {
      status: row.status,
      approver: row.approver,
      expiresAt: row.expiresAt?.toISOString() ?? null,
    };
  }

  async ownerOfActiveStream(runId: string): Promise<string | null> {
    const [thread] = await this.db
      .select({ actorRef: this.t.agentThread.actorRef })
      .from(this.t.agentThread)
      .where(
        and(eq(this.t.agentThread.activeStreamId, runId), isNull(this.t.agentThread.deletedAt)),
      );
    return thread?.actorRef ?? null;
  }

  async setTitle(threadId: string, title: string): Promise<void> {
    await this.db
      .update(this.t.agentThread)
      .set({ title, updatedAt: new Date() })
      .where(eq(this.t.agentThread.id, threadId));
  }

  async promoteThread(threadId: string): Promise<void> {
    await this.db
      .update(this.t.agentThread)
      .set({ transient: false, updatedAt: new Date() })
      .where(and(eq(this.t.agentThread.id, threadId), eq(this.t.agentThread.transient, true)));
  }

  /** Who holds the thread's stream right now, deleted or not. */
  private async activeHolder(threadId: string): Promise<string | null> {
    const [thread] = await this.db
      .select({ activeStreamId: this.t.agentThread.activeStreamId })
      .from(this.t.agentThread)
      .where(eq(this.t.agentThread.id, threadId));
    return thread?.activeStreamId ?? null;
  }

  /**
   * A thread's messages in the order they were appended: by `seq`, which append assigns. A row from
   * before `seq` existed has none and counts as 0 — first, since every such row is older than every
   * numbered one — and those order among themselves by `created_at`, then `id`, as they always did.
   * `coalesce` rather than `nulls first`, which MySQL cannot spell and Postgres defaults the other way.
   */
  private messageOrder(): SQL[] {
    const message = this.t.agentMessage;
    return [asc(sql`coalesce(${message.seq}, 0)`), asc(message.createdAt), asc(message.id)];
  }

  /** {@link messageOrder}, newest first. */
  private messageOrderNewestFirst(): SQL[] {
    const message = this.t.agentMessage;
    return [desc(sql`coalesce(${message.seq}, 0)`), desc(message.createdAt), desc(message.id)];
  }

  /**
   * The next `seq` in a thread: one past its highest. Two appends racing on ONE thread can draw the
   * same number — the turn loop never does that, and the tie then falls back to `created_at`, `id`.
   */
  private async nextMessageSeq(threadId: string): Promise<number> {
    const [row] = await this.db
      .select({ last: max(this.t.agentMessage.seq) })
      .from(this.t.agentMessage)
      .where(eq(this.t.agentMessage.threadId, threadId));
    return Number(row?.last ?? 0) + 1;
  }

  /** The run streaming the thread, or `null` — a projection of the one column. */
  async activeRunForThread(threadId: string): Promise<string | null> {
    const [thread] = await this.db
      .select({ activeStreamId: this.t.agentThread.activeStreamId })
      .from(this.t.agentThread)
      .where(and(eq(this.t.agentThread.id, threadId), isNull(this.t.agentThread.deletedAt)));
    return thread?.activeStreamId ?? null;
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
    const holders = [
      isNull(this.t.agentThread.activeStreamId),
      eq(this.t.agentThread.activeStreamId, runId),
      ...(options.replacing !== undefined
        ? [eq(this.t.agentThread.activeStreamId, options.replacing)]
        : []),
    ];
    const claimed = await affectedRows(
      this.dialect,
      this.db
        .update(this.t.agentThread)
        .set({ activeStreamId: runId })
        .where(and(eq(this.t.agentThread.id, threadId), or(...holders))),
      this.t.agentThread.id,
    );
    if (claimed > 0) {
      return true;
    }
    // Zero can still be a win: a MySQL connection without FOUND_ROWS reports CHANGED rows, and
    // re-claiming a thread this run already holds changes nothing. The row says who holds it now.
    return (await this.activeHolder(threadId)) === runId;
  }

  async releaseActiveStream(threadId: string, runId: string): Promise<boolean> {
    const released = await affectedRows(
      this.dialect,
      this.db
        .update(this.t.agentThread)
        .set({ activeStreamId: null })
        .where(
          and(eq(this.t.agentThread.id, threadId), eq(this.t.agentThread.activeStreamId, runId)),
        ),
      this.t.agentThread.id,
    );
    return released > 0;
  }

  async enqueueMessage(input: EnqueueMessageInput): Promise<QueuedMessage> {
    const now = new Date();
    const [edge] = await this.db
      .select({
        first: min(this.t.agentQueuedMessage.position),
        last: max(this.t.agentQueuedMessage.position),
      })
      .from(this.t.agentQueuedMessage)
      .where(eq(this.t.agentQueuedMessage.threadId, input.threadId));
    const position = input.at === 'head' ? (edge?.first ?? 1) - 1 : (edge?.last ?? -1) + 1;
    const row: AgentQueuedMessageRow = {
      id: crypto.randomUUID(),
      threadId: input.threadId,
      actor: input.actor,
      content: input.content,
      attachments:
        input.attachments !== undefined && input.attachments.length > 0 ? input.attachments : null,
      agentName: input.agentName ?? null,
      persona: input.persona ?? null,
      model: input.model ?? null,
      pageContext: input.pageContext ?? null,
      interrupt: input.interrupt === true,
      position,
      createdAt: now,
      updatedAt: now,
    };
    await this.db.insert(this.t.agentQueuedMessage).values(row);
    return toQueuedMessage(row);
  }

  async listQueue(threadId: string): Promise<QueuedMessage[]> {
    const rows = await this.db
      .select()
      .from(this.t.agentQueuedMessage)
      .where(eq(this.t.agentQueuedMessage.threadId, threadId))
      .orderBy(asc(this.t.agentQueuedMessage.position), asc(this.t.agentQueuedMessage.createdAt));
    return rows.map(toQueuedMessage);
  }

  async getQueuedMessage(id: string): Promise<QueuedMessage | null> {
    const [row] = await this.db
      .select()
      .from(this.t.agentQueuedMessage)
      .where(eq(this.t.agentQueuedMessage.id, id));
    return row === undefined ? null : toQueuedMessage(row);
  }

  async updateQueuedMessage(id: string, patch: QueuedMessagePatch): Promise<QueuedMessage | null> {
    const updates: Partial<AgentQueuedMessageRow> = { updatedAt: new Date() };
    if (patch.content !== undefined) {
      updates.content = patch.content;
    }
    if (patch.attachments !== undefined) {
      updates.attachments =
        patch.attachments === null || patch.attachments.length === 0 ? null : patch.attachments;
    }
    if (patch.interrupt !== undefined) {
      updates.interrupt = patch.interrupt;
    }
    await this.db
      .update(this.t.agentQueuedMessage)
      .set(updates)
      .where(eq(this.t.agentQueuedMessage.id, id));
    return this.getQueuedMessage(id);
  }

  /** Rewrites the thread's positions as 0..n-1 in the new order — a queue is a handful of rows. */
  async moveQueuedMessage(id: string, index: number): Promise<boolean> {
    const moving = await this.getQueuedMessage(id);
    if (moving === null) {
      return false;
    }
    const order = (await this.listQueue(moving.threadId)).filter((message) => message.id !== id);
    const target = Math.max(0, Math.min(order.length, Math.trunc(index)));
    order.splice(target, 0, moving);
    for (const [position, message] of order.entries()) {
      await this.db
        .update(this.t.agentQueuedMessage)
        .set({ position })
        .where(eq(this.t.agentQueuedMessage.id, message.id));
    }
    return true;
  }

  async removeQueuedMessage(id: string): Promise<boolean> {
    const removed = await affectedRows(
      this.dialect,
      this.db.delete(this.t.agentQueuedMessage).where(eq(this.t.agentQueuedMessage.id, id)),
      this.t.agentQueuedMessage.id,
    );
    return removed > 0;
  }

  async clearQueue(threadId: string): Promise<number> {
    return affectedRows(
      this.dialect,
      this.db
        .delete(this.t.agentQueuedMessage)
        .where(eq(this.t.agentQueuedMessage.threadId, threadId)),
      this.t.agentQueuedMessage.id,
    );
  }

  async queuePause(threadId: string): Promise<QueuePause | null> {
    const [thread] = await this.db
      .select({ queuePause: this.t.agentThread.queuePause })
      .from(this.t.agentThread)
      .where(eq(this.t.agentThread.id, threadId));
    return thread?.queuePause ?? null;
  }

  async setQueuePause(threadId: string, pause: QueuePause | null): Promise<void> {
    await this.db
      .update(this.t.agentThread)
      .set({ queuePause: pause })
      .where(eq(this.t.agentThread.id, threadId));
  }

  async setActiveStream(threadId: string, runId: string | null): Promise<void> {
    await this.db
      .update(this.t.agentThread)
      .set({ activeStreamId: runId })
      .where(eq(this.t.agentThread.id, threadId));
  }

  /**
   * Patch a thread's `title` and/or `defaultAgent`. Each field is only touched when PRESENT in
   * `patch` — `defaultAgent: null` clears it (falls back to the app default), while an omitted
   * `defaultAgent` leaves whatever is stored untouched. A no-op (including `updatedAt`) when the
   * patch is empty or the thread doesn't exist.
   */
  async updateThread(threadId: string, patch: UpdateThreadInput): Promise<void> {
    const updates: Partial<typeof agentThread.$inferInsert> = {};
    if (patch.title !== undefined) {
      updates.title = patch.title;
    }
    if (patch.defaultAgent !== undefined) {
      updates.defaultAgent = patch.defaultAgent;
    }
    if (patch.model !== undefined) {
      updates.model = patch.model;
    }
    if (patch.persona !== undefined) {
      updates.persona = patch.persona;
    }
    if (Object.keys(updates).length === 0) {
      return;
    }
    updates.updatedAt = new Date();
    await this.db
      .update(this.t.agentThread)
      .set(updates)
      .where(eq(this.t.agentThread.id, threadId));
  }

  /**
   * The thread's default agent, projected — the caller wants one nullable scalar to decide which
   * agent answers the next turn, and {@link getThread} would materialize the whole transcript to
   * hand it over. `null` when the thread is unknown, soft-deleted, or has no default set.
   */
  /** The thread's pinned model, projected like {@link defaultAgentForThread}. */
  async modelForThread(threadId: string): Promise<string | null> {
    const [thread] = await this.db
      .select({ model: this.t.agentThread.model })
      .from(this.t.agentThread)
      .where(and(eq(this.t.agentThread.id, threadId), isNull(this.t.agentThread.deletedAt)));
    return thread?.model ?? null;
  }

  /** The thread's pinned persona, projected like {@link defaultAgentForThread}. */
  async personaForThread(threadId: string): Promise<string | null> {
    const [thread] = await this.db
      .select({ persona: this.t.agentThread.persona })
      .from(agentThread)
      .where(and(eq(this.t.agentThread.id, threadId), isNull(this.t.agentThread.deletedAt)));
    return thread?.persona ?? null;
  }

  async defaultAgentForThread(threadId: string): Promise<string | null> {
    const [thread] = await this.db
      .select({ defaultAgent: this.t.agentThread.defaultAgent })
      .from(this.t.agentThread)
      .where(and(eq(this.t.agentThread.id, threadId), isNull(this.t.agentThread.deletedAt)));
    return thread?.defaultAgent ?? null;
  }

  /**
   * Persist the start of a run (turn). Replay-safe: called under a durable localStep.
   *
   * Takes the SPI's own {@link RecordRunStartInput} rather than a hand-copied shape: a field added
   * to the input is otherwise accepted and dropped, silently, by every adapter that re-declares it.
   */
  async recordRunStart(run: RecordRunStartInput): Promise<void> {
    const runRow: AgentRunRow = {
      id: run.runId,
      threadId: run.threadId,
      actorRef: run.actorRef,
      agentName: run.agentName ?? null,
      status: 'running',
      durationMs: null,
      errorCode: null,
      errorMessage: null,
      retries: 0,
      startedAt: new Date(),
      settledAt: null,
      promptHash: run.promptHash ?? null,
      parentRunId: run.parentRunId ?? null,
    };
    await this.db.insert(this.t.agentRun).values(runRow);
  }

  /** Settle a run's outcome. A no-op when the run is unknown (mirrors `setTitle`/`updateThread`). */
  async recordRunEnd(end: {
    runId: string;
    status: 'completed' | 'failed' | 'cancelled';
    durationMs?: number;
    errorCode?: string;
    errorMessage?: string;
  }): Promise<void> {
    const updates: Partial<typeof agentRun.$inferInsert> = {
      status: end.status,
      settledAt: new Date(),
    };
    if (end.durationMs !== undefined) {
      updates.durationMs = end.durationMs;
    }
    if (end.errorCode !== undefined) {
      updates.errorCode = end.errorCode;
    }
    if (end.errorMessage !== undefined) {
      updates.errorMessage = end.errorMessage;
    }
    await this.db.update(this.t.agentRun).set(updates).where(eq(this.t.agentRun.id, end.runId));
  }

  /** Bump the run's llm-step retry counter. Atomic `retries = retries + 1`, no read-modify-write. */
  async bumpRunRetries(runId: string): Promise<void> {
    await this.db
      .update(this.t.agentRun)
      .set({ retries: sql`${this.t.agentRun.retries} + 1` })
      .where(eq(this.t.agentRun.id, runId));
  }

  async appendMessage(input: AppendMessageInput): Promise<StoredMessage> {
    const [thread] = await this.db
      .select()
      .from(this.t.agentThread)
      .where(eq(this.t.agentThread.id, input.threadId));
    if (thread === undefined) {
      throw new Error(`thread ${input.threadId} not found`);
    }
    const now = new Date();
    const message: AgentMessageRow = {
      id: crypto.randomUUID(),
      threadId: input.threadId,
      role: input.role,
      content: input.content,
      toolCalls: input.toolCalls ?? null,
      toolResults: input.toolResults ?? null,
      attachments: input.attachments ?? null,
      followUps: input.followUps ?? null,
      usage: input.usage ?? null,
      agentName: input.agentName ?? null,
      persona: input.persona ?? null,
      runId: input.runId ?? null,
      reasoning: input.reasoning ?? null,
      reasoningMs: input.reasoningMs ?? null,
      ui: input.ui ?? null,
      feedback: null,
      seq: await this.nextMessageSeq(input.threadId),
      createdAt: now,
    };
    await this.db.insert(this.t.agentMessage).values(message);
    await this.db
      .update(this.t.agentThread)
      .set({ updatedAt: now })
      .where(eq(this.t.agentThread.id, input.threadId));
    return this.toStoredMessage(message);
  }

  async setMessageToolResults(messageId: string, results: ToolResult[]): Promise<void> {
    await this.db
      .update(this.t.agentMessage)
      .set({ toolResults: results })
      .where(eq(this.t.agentMessage.id, messageId));
  }

  async setMessageUi(messageId: string, ui: AgentUiComponent[]): Promise<void> {
    await this.db
      .update(this.t.agentMessage)
      .set({ ui: ui.length > 0 ? ui : null })
      .where(eq(this.t.agentMessage.id, messageId));
  }

  async threadOfMessage(messageId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ threadId: this.t.agentMessage.threadId })
      .from(this.t.agentMessage)
      .where(eq(this.t.agentMessage.id, messageId))
      .limit(1);
    return row?.threadId ?? null;
  }

  async setMessageFeedback(messageId: string, feedback: MessageFeedback | null): Promise<void> {
    await this.db
      .update(this.t.agentMessage)
      .set({ feedback })
      .where(eq(this.t.agentMessage.id, messageId));
  }

  async truncateFrom(threadId: string, messageId: string): Promise<void> {
    const messages = await this.db
      .select()
      .from(this.t.agentMessage)
      .where(eq(this.t.agentMessage.threadId, threadId))
      .orderBy(...this.messageOrder());
    const cutoff = messages.findIndex((message) => message.id === messageId);
    if (cutoff < 0) {
      return;
    }
    const doomedIds = messages.slice(cutoff).map((message) => message.id);
    await this.db
      .delete(this.t.agentToolCall)
      .where(inArray(this.t.agentToolCall.messageId, doomedIds));
    await this.db.delete(this.t.agentMessage).where(inArray(this.t.agentMessage.id, doomedIds));
  }

  async recordToolCall(input: RecordToolCallInput): Promise<void> {
    await this.db.insert(this.t.agentToolCall).values({
      id: input.toolCallId,
      messageId: input.messageId,
      toolName: input.toolName,
      toolType: input.toolType,
      input: input.input,
      output: null,
      status: input.status,
      executedByRef: null,
      executionMs: null,
      error: null,
      createdAt: new Date(),
      executedAt: null,
      runId: input.runId ?? null,
      approver: input.approver ?? null,
      confirmation: input.confirmation ?? null,
      expiresAt: input.expiresAt !== undefined ? new Date(input.expiresAt) : null,
      remember: null,
      decidedVia: null,
    });
  }

  async updateToolCall(input: UpdateToolCallInput): Promise<void> {
    const updates: Partial<typeof agentToolCall.$inferInsert> = { status: input.status };
    if (input.output !== undefined) {
      updates.output = input.output;
    }
    if (input.error !== undefined) {
      updates.error = input.error;
    }
    if (input.executionMs !== undefined) {
      updates.executionMs = input.executionMs;
    }
    if (input.executedByRef !== undefined) {
      updates.executedByRef = input.executedByRef;
    }
    if (input.remember !== undefined) {
      updates.remember = input.remember;
    }
    if (input.decidedVia !== undefined) {
      updates.decidedVia = input.decidedVia;
    }
    if (input.status === 'executed' || input.status === 'auto_executed') {
      updates.executedAt = new Date();
    }
    await this.db
      .update(this.t.agentToolCall)
      .set(updates)
      .where(eq(this.t.agentToolCall.id, input.toolCallId));
  }

  async toolCallOutcomes(toolCallIds: readonly string[]): Promise<ToolCallOutcome[]> {
    if (toolCallIds.length === 0) {
      return [];
    }
    const rows = await this.db
      .select({
        id: this.t.agentToolCall.id,
        status: this.t.agentToolCall.status,
        output: this.t.agentToolCall.output,
        error: this.t.agentToolCall.error,
      })
      .from(this.t.agentToolCall)
      .where(inArray(this.t.agentToolCall.id, [...toolCallIds]));
    return rows.map((row) => ({
      id: row.id,
      status: row.status,
      ...(row.output !== undefined && row.output !== null ? { output: row.output } : {}),
      ...(typeof row.error === 'string' ? { error: row.error } : {}),
    }));
  }

  async failUnsettledToolCalls(runId: string, error: string): Promise<number> {
    const pending = and(
      eq(this.t.agentToolCall.runId, runId),
      eq(this.t.agentToolCall.status, 'pending_approval'),
    );
    // Counted first: an UPDATE's affected-row count is spelled differently by every driver this
    // adapter runs on. The number is informational; the write is what matters.
    const rows = await this.db
      .select({ id: this.t.agentToolCall.id })
      .from(this.t.agentToolCall)
      .where(pending);
    if (rows.length === 0) {
      return 0;
    }
    await this.db.update(this.t.agentToolCall).set({ status: 'failed', error }).where(pending);
    return rows.length;
  }

  /**
   * Of `mediaIds`, the ones a surviving message — or a message waiting in the queue — in one of
   * this actor's threads still carries.
   *
   * Reads the `attachments` JSON back out and matches in memory rather than pushing the match into
   * SQL: the column holds an array of objects, and every dialect this adapter's sibling targets
   * spells that query differently (`jsonb` containment, `json_table`, `json_each`), while none of
   * them can use an index for it anyway. The scan is bounded by ONE actor's attachment-bearing
   * messages, which is a small set — attachments are rare, and a message without one is excluded
   * by the `is not null` before any JSON is parsed.
   *
   * Soft-deleted threads are deliberately included: their message rows survive, so the bytes they
   * point at are still reachable from stored state and are not garbage.
   */
  async referencedMediaIds(actorRef: string, mediaIds: readonly string[]): Promise<string[]> {
    if (mediaIds.length === 0) {
      return [];
    }
    const rows = await this.db
      .select({ attachments: this.t.agentMessage.attachments })
      .from(this.t.agentMessage)
      .innerJoin(this.t.agentThread, eq(this.t.agentMessage.threadId, this.t.agentThread.id))
      .where(
        and(eq(this.t.agentThread.actorRef, actorRef), isNotNull(this.t.agentMessage.attachments)),
      );
    // A message waiting in a thread's queue has been sent and not yet run: what it carries is in use.
    const queued = await this.db
      .select({ attachments: this.t.agentQueuedMessage.attachments })
      .from(this.t.agentQueuedMessage)
      .innerJoin(this.t.agentThread, eq(this.t.agentQueuedMessage.threadId, this.t.agentThread.id))
      .where(
        and(
          eq(this.t.agentThread.actorRef, actorRef),
          isNotNull(this.t.agentQueuedMessage.attachments),
        ),
      );
    const wanted = new Set(mediaIds);
    const found = new Set<string>();
    for (const row of [...rows, ...queued]) {
      for (const attachment of row.attachments ?? []) {
        if (wanted.has(attachment.mediaId)) {
          found.add(attachment.mediaId);
        }
      }
    }
    return [...wanted].filter((mediaId) => found.has(mediaId));
  }

  async recordUsage(input: RecordUsageInput): Promise<void> {
    await this.db.insert(this.t.agentTokenUsage).values({
      id: crypto.randomUUID(),
      threadId: input.threadId,
      actorRef: input.actorRef,
      messageId: input.messageId ?? null,
      modelId: input.modelId,
      purpose: input.purpose,
      inputTokens: input.usage.inputTokens,
      outputTokens: input.usage.outputTokens,
      cacheWriteTokens: input.usage.cacheWriteTokens ?? null,
      cacheReadTokens: input.usage.cacheReadTokens ?? null,
      costUsd: input.costUsd ?? null,
      createdAt: new Date(),
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
    const start = new Date(`${fromDay}T00:00:00.000Z`);
    const end = new Date(`${toDay}T23:59:59.999Z`);
    const rows = await this.db
      .select()
      .from(this.t.agentTokenUsage)
      .where(
        and(
          eq(this.t.agentTokenUsage.actorRef, actorRef),
          gte(this.t.agentTokenUsage.createdAt, start),
          lte(this.t.agentTokenUsage.createdAt, end),
        ),
      );
    const usedTokens = rows.reduce((sum, row) => sum + row.inputTokens + row.outputTokens, 0);
    const costUsd = rows.reduce((sum, row) => sum + (row.costUsd ?? 0), 0);
    return { usedTokens, costUsd };
  }

  private toSummary(thread: AgentThreadRow, lastContent?: string): ThreadSummary {
    return {
      id: thread.id,
      title: thread.title,
      transient: thread.transient,
      createdAt: thread.createdAt.toISOString(),
      updatedAt: thread.updatedAt.toISOString(),
      defaultAgent: thread.defaultAgent,
      ...(thread.model != null ? { model: thread.model } : {}),
      persona: thread.persona ?? null,
      ...(lastContent !== undefined ? { lastMessagePreview: lastContent.slice(0, 120) } : {}),
    };
  }

  private toStoredMessage(message: TurnMessageRow & Partial<AgentMessageRow>): StoredMessage {
    return {
      id: message.id,
      role: message.role,
      content: message.content,
      createdAt: message.createdAt.toISOString(),
      ...(message.toolCalls != null ? { toolCalls: message.toolCalls } : {}),
      ...(message.toolResults != null ? { toolResults: message.toolResults } : {}),
      ...(message.attachments != null ? { attachments: message.attachments } : {}),
      ...(message.followUps != null ? { followUps: message.followUps } : {}),
      ...(message.usage != null ? { usage: message.usage } : {}),
      ...(message.agentName != null ? { agentName: message.agentName } : {}),
      ...(message.persona != null ? { persona: message.persona } : {}),
      ...(message.runId != null ? { runId: message.runId } : {}),
      ...(message.reasoning != null ? { reasoning: message.reasoning } : {}),
      ...(message.reasoningMs != null ? { reasoningMs: message.reasoningMs } : {}),
      ...(message.ui != null ? { ui: message.ui } : {}),
      ...(message.feedback != null ? { feedback: message.feedback } : {}),
    };
  }
}

function toQueuedMessage(row: AgentQueuedMessageRow): QueuedMessage {
  return {
    id: row.id,
    threadId: row.threadId,
    actor: row.actor,
    content: row.content,
    ...(row.attachments !== null && row.attachments.length > 0
      ? { attachments: row.attachments }
      : {}),
    ...(row.agentName !== null ? { agentName: row.agentName } : {}),
    ...(row.persona !== null ? { persona: row.persona } : {}),
    ...(row.model !== null ? { model: row.model } : {}),
    ...(row.pageContext !== null ? { pageContext: row.pageContext } : {}),
    ...(row.interrupt ? { interrupt: true } : {}),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
