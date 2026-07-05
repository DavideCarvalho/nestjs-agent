import type {
  AgentStore,
  AppendMessageInput,
  CreateThreadInput,
  RecordToolCallInput,
  RecordUsageInput,
  StoredMessage,
  ThreadDetail,
  ThreadSummary,
  ToolCallStatus,
  UpdateToolCallInput,
} from '@dudousxd/nestjs-agent-core';

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
  createdAt: string;
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
  createdAt: string;
}

/** Thread metadata exposed to the governance read-model (title/actor/count/last activity). */
export interface GovernanceThreadRow {
  threadId: string;
  title: string;
  actorRef: string;
  messageCount: number;
  updatedAt: string;
}

/** A fully in-memory `AgentStore` for tests and the offline demo. */
export class InMemoryAgentStore implements AgentStore {
  private readonly threads = new Map<string, ThreadRow>();
  private readonly toolCalls = new Map<string, ToolCallRow>();
  private readonly usage: UsageRow[] = [];

  private now(): string {
    return new Date().toISOString();
  }

  async createThread(input: CreateThreadInput): Promise<ThreadSummary> {
    const id = crypto.randomUUID();
    const ts = this.now();
    const row: ThreadRow = {
      id,
      actorRef: input.actor.id,
      title: input.title ?? 'New chat',
      persona: input.persona,
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
      messages: row.messages,
      ...(row.activeStreamId !== undefined ? { activeStreamId: row.activeStreamId } : {}),
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
      persona: source.persona,
      transient: false,
      createdAt: ts,
      updatedAt: ts,
      messages: kept.map((message) => ({ ...message })),
    };
    this.threads.set(id, row);
    return this.toSummary(row);
  }

  async setTitle(threadId: string, title: string): Promise<void> {
    const row = this.threads.get(threadId);
    if (row !== undefined) {
      row.title = title;
      row.updatedAt = this.now();
    }
  }

  async setActiveStream(threadId: string, runId: string | null): Promise<void> {
    const row = this.threads.get(threadId);
    if (row !== undefined) {
      if (runId === null) {
        delete row.activeStreamId;
      } else {
        row.activeStreamId = runId;
      }
    }
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
      ...(input.followUps !== undefined ? { followUps: input.followUps } : {}),
      ...(input.usage !== undefined ? { usage: input.usage } : {}),
    };
    row.messages.push(message);
    row.updatedAt = message.createdAt;
    return message;
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
    });
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

  async quotaToday(actorRef: string, day: string): Promise<{ usedTokens: number }> {
    const usedTokens = this.usage
      .filter((row) => row.actorRef === actorRef && row.day === day)
      .reduce((sum, row) => sum + row.inputTokens + row.outputTokens, 0);
    return { usedTokens };
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
      createdAt: row.createdAt,
    }));
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

  private threadIdForMessage(messageId: string): string | undefined {
    for (const [threadId, row] of this.threads) {
      if (row.messages.some((message) => message.id === messageId)) {
        return threadId;
      }
    }
    return undefined;
  }

  /** Test helper: read the recorded tool-call rows. */
  toolCallRows(): { toolName: string; status: ToolCallStatus; output?: unknown }[] {
    return [...this.toolCalls.values()].map((row) => ({
      toolName: row.toolName,
      status: row.status,
      ...(row.output !== undefined ? { output: row.output } : {}),
    }));
  }

  private toSummary(row: ThreadRow): ThreadSummary {
    const last = row.messages[row.messages.length - 1];
    return {
      id: row.id,
      title: row.title,
      persona: row.persona,
      transient: row.transient,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      ...(row.pinnedAt !== undefined ? { pinnedAt: row.pinnedAt } : {}),
      ...(last !== undefined ? { lastMessagePreview: last.content.slice(0, 120) } : {}),
    };
  }
}
