import type {
  AgentStore,
  AppendMessageInput,
  CreateThreadInput,
  RecordRunStartInput,
  RecordToolCallInput,
  RecordUsageInput,
  StoredMessage,
  ThreadDetail,
  ThreadSummary,
  ThreadTurnPage,
  ThreadTurnQuery,
  ThreadTurnReader,
  ToolResult,
  UpdateThreadInput,
  UpdateToolCallInput,
} from '@dudousxd/nestjs-agent-core';
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import {
  type AgentDrizzleDb,
  type AgentMessageRow,
  type AgentRunRow,
  type AgentThreadRow,
  agentMessage,
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
const TURN_MESSAGE_COLUMNS = {
  id: agentMessage.id,
  role: agentMessage.role,
  content: agentMessage.content,
  agentName: agentMessage.agentName,
  toolCalls: agentMessage.toolCalls,
  toolResults: agentMessage.toolResults,
  attachments: agentMessage.attachments,
  createdAt: agentMessage.createdAt,
};

type TurnMessageRow = { [K in keyof typeof TURN_MESSAGE_COLUMNS]: AgentMessageRow[K] };

/**
 * {@link AgentStore} backed by Drizzle ORM — a second adapter alongside the MikroORM one, proving
 * the store SPI is ORM-portable. A POJO receiving a Drizzle SQLite database handle (the host app
 * owns the connection). Behaviour mirrors {@link import('@dudousxd/nestjs-agent-store-mikro-orm')}
 * exactly (fork/truncate/quota/active-stream/soft-delete semantics) so the two are interchangeable.
 */
export class DrizzleAgentStore implements AgentStore, ThreadTurnReader {
  constructor(private readonly db: AgentDrizzleDb) {}

  async createThread(input: CreateThreadInput): Promise<ThreadSummary> {
    const now = new Date();
    const thread: AgentThreadRow = {
      id: crypto.randomUUID(),
      actorRef: input.actor.id,
      tenantRef: input.actor.tenantRef ?? null,
      title: input.title ?? 'New chat',
      transient: input.transient ?? false,
      activeStreamId: null,
      defaultAgent: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    await this.db.insert(agentThread).values(thread);
    return this.toSummary(thread);
  }

  async getThread(threadId: string): Promise<ThreadDetail | null> {
    const [thread] = await this.db
      .select()
      .from(agentThread)
      .where(and(eq(agentThread.id, threadId), isNull(agentThread.deletedAt)));
    if (thread === undefined) {
      return null;
    }
    const messages = await this.db
      .select()
      .from(agentMessage)
      .where(eq(agentMessage.threadId, threadId))
      .orderBy(asc(agentMessage.createdAt), asc(agentMessage.id));
    const last = messages[messages.length - 1];
    return {
      ...this.toSummary(thread, last?.content),
      messages: messages.map((message) => this.toStoredMessage(message)),
      ...(thread.activeStreamId != null ? { activeStreamId: thread.activeStreamId } : {}),
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
      .select({ title: agentThread.title, defaultAgent: agentThread.defaultAgent })
      .from(agentThread)
      .where(and(eq(agentThread.id, query.threadId), isNull(agentThread.deletedAt)));
    if (thread === undefined) {
      return null;
    }
    const messages = await this.loadTurnWindow(query.threadId, query.messageLimit);
    const [answered] = await this.db
      .select({ id: agentMessage.id })
      .from(agentMessage)
      .where(and(eq(agentMessage.threadId, query.threadId), eq(agentMessage.role, 'assistant')))
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
      .select(TURN_MESSAGE_COLUMNS)
      .from(agentMessage)
      .where(eq(agentMessage.threadId, threadId))
      .orderBy(desc(agentMessage.createdAt), desc(agentMessage.id));
    const rows: TurnMessageRow[] = limit === undefined ? await window : await window.limit(limit);
    return rows.reverse().map((row) => this.toStoredMessage(row));
  }

  async listThreads(actorRef: string, limit = 50): Promise<ThreadSummary[]> {
    const threads = await this.db
      .select()
      .from(agentThread)
      .where(
        and(
          eq(agentThread.actorRef, actorRef),
          eq(agentThread.transient, false),
          isNull(agentThread.deletedAt),
        ),
      )
      .orderBy(desc(agentThread.updatedAt))
      .limit(limit);
    const summaries: ThreadSummary[] = [];
    for (const thread of threads) {
      const [last] = await this.db
        .select()
        .from(agentMessage)
        .where(eq(agentMessage.threadId, thread.id))
        .orderBy(desc(agentMessage.createdAt), desc(agentMessage.id))
        .limit(1);
      summaries.push(this.toSummary(thread, last?.content));
    }
    return summaries;
  }

  async softDeleteThread(threadId: string): Promise<void> {
    await this.db
      .update(agentThread)
      .set({ deletedAt: new Date() })
      .where(eq(agentThread.id, threadId));
  }

  async forkThread(threadId: string, fromMessageId: string): Promise<ThreadSummary> {
    const [source] = await this.db.select().from(agentThread).where(eq(agentThread.id, threadId));
    if (source === undefined) {
      throw new Error(`thread ${threadId} not found`);
    }
    const messages = await this.db
      .select()
      .from(agentMessage)
      .where(eq(agentMessage.threadId, threadId))
      .orderBy(asc(agentMessage.createdAt), asc(agentMessage.id));
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
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    await this.db.insert(agentThread).values(fork);
    if (kept.length > 0) {
      await this.db.insert(agentMessage).values(
        kept.map((message) => ({
          id: crypto.randomUUID(),
          threadId: fork.id,
          role: message.role,
          content: message.content,
          toolCalls: message.toolCalls,
          toolResults: message.toolResults,
          attachments: message.attachments,
          followUps: message.followUps,
          usage: message.usage,
          agentName: message.agentName,
          // The copy is the same message, so it keeps the run that wrote it. A reader asking which
          // turn produced this text gets the truthful answer; the run's own thread is still the
          // original, so a run-scoped read never picks the fork's rows up.
          runId: message.runId,
          createdAt: message.createdAt,
        })),
      );
    }
    return this.toSummary(fork);
  }

  async ownerOfThread(threadId: string): Promise<string | null> {
    const [thread] = await this.db
      .select({ actorRef: agentThread.actorRef })
      .from(agentThread)
      .where(and(eq(agentThread.id, threadId), isNull(agentThread.deletedAt)));
    return thread?.actorRef ?? null;
  }

  async ownerOfToolCall(toolCallId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ actorRef: agentThread.actorRef })
      .from(agentToolCall)
      .innerJoin(agentMessage, eq(agentToolCall.messageId, agentMessage.id))
      .innerJoin(agentThread, eq(agentMessage.threadId, agentThread.id))
      .where(eq(agentToolCall.id, toolCallId));
    return row?.actorRef ?? null;
  }

  async runForToolCall(toolCallId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ runId: agentToolCall.runId, activeStreamId: agentThread.activeStreamId })
      .from(agentToolCall)
      .innerJoin(agentMessage, eq(agentToolCall.messageId, agentMessage.id))
      .innerJoin(agentThread, eq(agentMessage.threadId, agentThread.id))
      .where(eq(agentToolCall.id, toolCallId));
    return row?.runId ?? row?.activeStreamId ?? null;
  }

  async ownerOfActiveStream(runId: string): Promise<string | null> {
    const [thread] = await this.db
      .select({ actorRef: agentThread.actorRef })
      .from(agentThread)
      .where(and(eq(agentThread.activeStreamId, runId), isNull(agentThread.deletedAt)));
    return thread?.actorRef ?? null;
  }

  async setTitle(threadId: string, title: string): Promise<void> {
    await this.db
      .update(agentThread)
      .set({ title, updatedAt: new Date() })
      .where(eq(agentThread.id, threadId));
  }

  async promoteThread(threadId: string): Promise<void> {
    await this.db
      .update(agentThread)
      .set({ transient: false, updatedAt: new Date() })
      .where(and(eq(agentThread.id, threadId), eq(agentThread.transient, true)));
  }

  async setActiveStream(threadId: string, runId: string | null): Promise<void> {
    await this.db
      .update(agentThread)
      .set({ activeStreamId: runId })
      .where(eq(agentThread.id, threadId));
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
    if (Object.keys(updates).length === 0) {
      return;
    }
    updates.updatedAt = new Date();
    await this.db.update(agentThread).set(updates).where(eq(agentThread.id, threadId));
  }

  /**
   * The thread's default agent, projected — the caller wants one nullable scalar to decide which
   * agent answers the next turn, and {@link getThread} would materialize the whole transcript to
   * hand it over. `null` when the thread is unknown, soft-deleted, or has no default set.
   */
  async defaultAgentForThread(threadId: string): Promise<string | null> {
    const [thread] = await this.db
      .select({ defaultAgent: agentThread.defaultAgent })
      .from(agentThread)
      .where(and(eq(agentThread.id, threadId), isNull(agentThread.deletedAt)));
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
    await this.db.insert(agentRun).values(runRow);
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
    await this.db.update(agentRun).set(updates).where(eq(agentRun.id, end.runId));
  }

  /** Bump the run's llm-step retry counter. Atomic `retries = retries + 1`, no read-modify-write. */
  async bumpRunRetries(runId: string): Promise<void> {
    await this.db
      .update(agentRun)
      .set({ retries: sql`${agentRun.retries} + 1` })
      .where(eq(agentRun.id, runId));
  }

  async appendMessage(input: AppendMessageInput): Promise<StoredMessage> {
    const [thread] = await this.db
      .select()
      .from(agentThread)
      .where(eq(agentThread.id, input.threadId));
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
      runId: input.runId ?? null,
      createdAt: now,
    };
    await this.db.insert(agentMessage).values(message);
    await this.db
      .update(agentThread)
      .set({ updatedAt: now })
      .where(eq(agentThread.id, input.threadId));
    return this.toStoredMessage(message);
  }

  async setMessageToolResults(messageId: string, results: ToolResult[]): Promise<void> {
    await this.db
      .update(agentMessage)
      .set({ toolResults: results })
      .where(eq(agentMessage.id, messageId));
  }

  async truncateFrom(threadId: string, messageId: string): Promise<void> {
    const messages = await this.db
      .select()
      .from(agentMessage)
      .where(eq(agentMessage.threadId, threadId))
      .orderBy(asc(agentMessage.createdAt), asc(agentMessage.id));
    const cutoff = messages.findIndex((message) => message.id === messageId);
    if (cutoff < 0) {
      return;
    }
    const doomedIds = messages.slice(cutoff).map((message) => message.id);
    await this.db.delete(agentToolCall).where(inArray(agentToolCall.messageId, doomedIds));
    await this.db.delete(agentMessage).where(inArray(agentMessage.id, doomedIds));
  }

  async recordToolCall(input: RecordToolCallInput): Promise<void> {
    await this.db.insert(agentToolCall).values({
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
    if (input.status === 'executed' || input.status === 'auto_executed') {
      updates.executedAt = new Date();
    }
    await this.db.update(agentToolCall).set(updates).where(eq(agentToolCall.id, input.toolCallId));
  }

  /**
   * Of `mediaIds`, the ones a surviving message in one of this actor's threads still carries.
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
      .select({ attachments: agentMessage.attachments })
      .from(agentMessage)
      .innerJoin(agentThread, eq(agentMessage.threadId, agentThread.id))
      .where(and(eq(agentThread.actorRef, actorRef), isNotNull(agentMessage.attachments)));
    const wanted = new Set(mediaIds);
    const found = new Set<string>();
    for (const row of rows) {
      for (const attachment of row.attachments ?? []) {
        if (wanted.has(attachment.mediaId)) {
          found.add(attachment.mediaId);
        }
      }
    }
    return [...wanted].filter((mediaId) => found.has(mediaId));
  }

  async recordUsage(input: RecordUsageInput): Promise<void> {
    await this.db.insert(agentTokenUsage).values({
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
    const start = new Date(`${day}T00:00:00.000Z`);
    const end = new Date(`${day}T23:59:59.999Z`);
    const rows = await this.db
      .select()
      .from(agentTokenUsage)
      .where(
        and(
          eq(agentTokenUsage.actorRef, actorRef),
          gte(agentTokenUsage.createdAt, start),
          lte(agentTokenUsage.createdAt, end),
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
      ...(message.runId != null ? { runId: message.runId } : {}),
    };
  }
}
