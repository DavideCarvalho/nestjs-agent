import type {
  AgentStore,
  AppendMessageInput,
  CreateThreadInput,
  RecordToolCallInput,
  RecordUsageInput,
  StoredMessage,
  ThreadDetail,
  ThreadSummary,
  ToolResult,
  UpdateToolCallInput,
} from '@dudousxd/nestjs-agent-core';
import type { EntityManager } from '@mikro-orm/core';
import { AgentMessage } from './entities/agent-message.entity';
import { AgentThread } from './entities/agent-thread.entity';
import { AgentTokenUsage } from './entities/agent-token-usage.entity';
import { AgentToolCall } from './entities/agent-tool-call.entity';

/**
 * {@link AgentStore} backed by MikroORM. A POJO receiving an {@link EntityManager}; each
 * operation runs on a fresh `em.fork()` so per-request identity maps never bleed across
 * concurrent turns. Behaviour mirrors the in-memory reference store (fork/truncate/quota/
 * active-stream/soft-delete semantics) so the two are interchangeable in tests.
 */
export class MikroOrmAgentStore implements AgentStore {
  constructor(private readonly em: EntityManager) {}

  async createThread(input: CreateThreadInput): Promise<ThreadSummary> {
    const em = this.em.fork();
    const now = new Date();
    const thread = em.create(AgentThread, {
      id: crypto.randomUUID(),
      actorRef: input.actor.id,
      title: input.title ?? 'New chat',
      transient: input.transient ?? false,
      createdAt: now,
      updatedAt: now,
      ...(input.actor.tenantRef !== undefined ? { tenantRef: input.actor.tenantRef } : {}),
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
    const messages = await em.find(
      AgentMessage,
      { thread },
      { orderBy: { createdAt: 'asc', id: 'asc' } },
    );
    // Tool RESULTS live on the `agent_tool_call` records (the source of truth for outputs), not on
    // the message row. Rebuild each assistant message's `toolResults` from its resolved calls so a
    // reloaded thread feeds a complete assistant+tool pair back to the model — without this a
    // multi-turn thread that used tools throws MissingToolResultsError on the NEXT turn, since the
    // prior assistant message would carry tool calls with no matching results.
    const resultsByMessage = await this.loadToolResults(em, messages);
    const last = messages[messages.length - 1];
    return {
      ...this.toSummary(thread, last?.content),
      messages: messages.map((message) =>
        this.toStoredMessage(message, resultsByMessage.get(message.id)),
      ),
      ...(thread.activeStreamId != null ? { activeStreamId: thread.activeStreamId } : {}),
    };
  }

  /**
   * Group each message's resolved tool calls into `ToolResult[]`, keyed by message id. A call is
   * "resolved" once it has run (executed/failed/rejected) — a pending-approval call has no result
   * yet and is skipped, so a mid-approval turn doesn't inject a phantom empty result.
   */
  private async loadToolResults(
    em: EntityManager,
    messages: AgentMessage[],
  ): Promise<Map<string, ToolResult[]>> {
    const withCalls = messages.filter((message) => message.toolCalls != null);
    const byMessage = new Map<string, ToolResult[]>();
    if (withCalls.length === 0) {
      return byMessage;
    }
    const calls = await em.find(
      AgentToolCall,
      { message: { $in: withCalls }, status: { $ne: 'pending_approval' } },
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
        { orderBy: { createdAt: 'desc', id: 'desc' } },
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
    const messages = await em.find(
      AgentMessage,
      { thread: source },
      { orderBy: { createdAt: 'asc', id: 'asc' } },
    );
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
    });
    em.persist(fork);
    for (const message of kept) {
      em.persist(
        em.create(AgentMessage, {
          id: crypto.randomUUID(),
          thread: fork,
          role: message.role,
          content: message.content,
          createdAt: message.createdAt,
          ...(message.toolCalls != null ? { toolCalls: message.toolCalls } : {}),
          ...(message.toolResults != null ? { toolResults: message.toolResults } : {}),
          ...(message.followUps != null ? { followUps: message.followUps } : {}),
          ...(message.usage != null ? { usage: message.usage } : {}),
          ...(message.agentName != null ? { agentName: message.agentName } : {}),
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
    return toolCall?.message.thread.activeStreamId ?? null;
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

  async setActiveStream(threadId: string, runId: string | null): Promise<void> {
    const em = this.em.fork();
    const thread = await em.findOne(AgentThread, { id: threadId });
    if (thread !== null) {
      thread.activeStreamId = runId;
      await em.flush();
    }
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
      createdAt: now,
      ...(input.toolCalls !== undefined ? { toolCalls: input.toolCalls } : {}),
      ...(input.toolResults !== undefined ? { toolResults: input.toolResults } : {}),
      ...(input.attachments !== undefined ? { attachments: input.attachments } : {}),
      ...(input.followUps !== undefined ? { followUps: input.followUps } : {}),
      ...(input.usage !== undefined ? { usage: input.usage } : {}),
      ...(input.agentName !== undefined ? { agentName: input.agentName } : {}),
    });
    thread.updatedAt = now;
    em.persist(message);
    await em.flush();
    return this.toStoredMessage(message);
  }

  async truncateFrom(threadId: string, messageId: string): Promise<void> {
    const em = this.em.fork();
    const thread = await em.findOne(AgentThread, { id: threadId });
    if (thread === null) {
      return;
    }
    const messages = await em.find(
      AgentMessage,
      { thread },
      { orderBy: { createdAt: 'asc', id: 'asc' } },
    );
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
    if (input.status === 'executed' || input.status === 'auto_executed') {
      toolCall.executedAt = new Date();
    }
    await em.flush();
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
    const em = this.em.fork();
    const start = new Date(`${day}T00:00:00.000Z`);
    const end = new Date(`${day}T23:59:59.999Z`);
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
      ...(lastContent !== undefined ? { lastMessagePreview: lastContent.slice(0, 120) } : {}),
    };
  }

  private toStoredMessage(message: AgentMessage, toolResults?: ToolResult[]): StoredMessage {
    // Prefer results rebuilt from the tool-call records; fall back to the (legacy) message column.
    const resolvedResults =
      toolResults !== undefined && toolResults.length > 0 ? toolResults : message.toolResults;
    return {
      id: message.id,
      role: message.role,
      content: message.content,
      createdAt: message.createdAt.toISOString(),
      ...(message.agentName != null ? { agentName: message.agentName } : {}),
      ...(message.toolCalls != null ? { toolCalls: message.toolCalls } : {}),
      ...(resolvedResults != null ? { toolResults: resolvedResults } : {}),
      ...(message.attachments != null ? { attachments: message.attachments } : {}),
      ...(message.followUps != null ? { followUps: message.followUps } : {}),
      ...(message.usage != null ? { usage: message.usage } : {}),
    };
  }
}
