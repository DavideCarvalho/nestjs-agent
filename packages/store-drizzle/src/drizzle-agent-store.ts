import type {
  AgentStore,
  AppendMessageInput,
  CreateThreadInput,
  RecordToolCallInput,
  RecordUsageInput,
  StoredMessage,
  ThreadDetail,
  ThreadSummary,
  UpdateToolCallInput,
} from '@dudousxd/nestjs-agent-core';
import { and, asc, desc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
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
 * {@link AgentStore} backed by Drizzle ORM — a second adapter alongside the MikroORM one, proving
 * the store SPI is ORM-portable. A POJO receiving a Drizzle SQLite database handle (the host app
 * owns the connection). Behaviour mirrors {@link import('@dudousxd/nestjs-agent-store-mikro-orm')}
 * exactly (fork/truncate/quota/active-stream/soft-delete semantics) so the two are interchangeable.
 */
export class DrizzleAgentStore implements AgentStore {
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
          followUps: message.followUps,
          usage: message.usage,
          agentName: message.agentName,
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
      .select({ activeStreamId: agentThread.activeStreamId })
      .from(agentToolCall)
      .innerJoin(agentMessage, eq(agentToolCall.messageId, agentMessage.id))
      .innerJoin(agentThread, eq(agentMessage.threadId, agentThread.id))
      .where(eq(agentToolCall.id, toolCallId));
    return row?.activeStreamId ?? null;
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

  /** Persist the start of a run (turn). Replay-safe: called under a durable localStep. */
  async recordRunStart(run: {
    runId: string;
    threadId: string;
    actorRef: string;
    agentName?: string;
    promptHash?: string;
  }): Promise<void> {
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
    };
    await this.db.insert(agentRun).values(runRow);
  }

  /** Settle a run's outcome. A no-op when the run is unknown (mirrors `setTitle`/`updateThread`). */
  async recordRunEnd(end: {
    runId: string;
    status: 'completed' | 'failed';
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
      followUps: input.followUps ?? null,
      usage: input.usage ?? null,
      agentName: input.agentName ?? null,
      createdAt: now,
    };
    await this.db.insert(agentMessage).values(message);
    await this.db
      .update(agentThread)
      .set({ updatedAt: now })
      .where(eq(agentThread.id, input.threadId));
    return this.toStoredMessage(message);
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
      ...(lastContent !== undefined ? { lastMessagePreview: lastContent.slice(0, 120) } : {}),
    };
  }

  private toStoredMessage(message: AgentMessageRow): StoredMessage {
    return {
      id: message.id,
      role: message.role,
      content: message.content,
      createdAt: message.createdAt.toISOString(),
      ...(message.toolCalls != null ? { toolCalls: message.toolCalls } : {}),
      ...(message.toolResults != null ? { toolResults: message.toolResults } : {}),
      ...(message.followUps != null ? { followUps: message.followUps } : {}),
      ...(message.usage != null ? { usage: message.usage } : {}),
      ...(message.agentName != null ? { agentName: message.agentName } : {}),
    };
  }
}
