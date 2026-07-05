import type {
  Actor,
  MessageUsage,
  StoredMessage,
  ThreadDetail,
  ThreadSummary,
  ToolCallRequest,
  ToolCallStatus,
  ToolResult,
  UsagePurpose,
} from '../types.js';

export interface CreateThreadInput {
  actor: Actor;
  persona: string;
  transient?: boolean;
  title?: string;
}

export interface AppendMessageInput {
  threadId: string;
  role: StoredMessage['role'];
  content: string;
  persona?: string;
  toolCalls?: ToolCallRequest[];
  toolResults?: ToolResult[];
  followUps?: string[];
  usage?: MessageUsage;
}

export interface RecordToolCallInput {
  toolCallId: string;
  messageId: string;
  toolName: string;
  toolType: 'read' | 'action';
  input: unknown;
  status: ToolCallStatus;
}

export interface UpdateToolCallInput {
  toolCallId: string;
  status: ToolCallStatus;
  output?: unknown;
  error?: string;
  executionMs?: number;
  executedByRef?: string;
}

export interface RecordUsageInput {
  threadId: string;
  actorRef: string;
  messageId?: string;
  modelId: string;
  purpose: UsagePurpose;
  usage: MessageUsage;
  /** Provider-reported actual USD cost for this turn, when known (gateways report it). */
  costUsd?: number;
}

/** ORM-agnostic persistence. Refs are string ids; adapters may add real relations. */
export interface AgentStore {
  createThread(input: CreateThreadInput): Promise<ThreadSummary>;
  getThread(threadId: string): Promise<ThreadDetail | null>;
  listThreads(actorRef: string, limit?: number): Promise<ThreadSummary[]>;
  softDeleteThread(threadId: string): Promise<void>;
  forkThread(threadId: string, fromMessageId: string): Promise<ThreadSummary>;
  setTitle(threadId: string, title: string): Promise<void>;
  setActiveStream(threadId: string, runId: string | null): Promise<void>;

  appendMessage(input: AppendMessageInput): Promise<StoredMessage>;
  truncateFrom(threadId: string, messageId: string): Promise<void>;

  recordToolCall(input: RecordToolCallInput): Promise<void>;
  updateToolCall(input: UpdateToolCallInput): Promise<void>;

  recordUsage(input: RecordUsageInput): Promise<void>;
  quotaToday(actorRef: string, day: string): Promise<{ usedTokens: number }>;
}
