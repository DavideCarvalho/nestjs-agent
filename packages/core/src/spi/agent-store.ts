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
  transient?: boolean;
  title?: string;
}

export interface AppendMessageInput {
  threadId: string;
  role: StoredMessage['role'];
  content: string;
  /** Which agent produced this message (assistant messages) — provenance. */
  agentName?: string;
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
  /**
   * Promote a transient thread to a persistent one so it shows up in {@link listThreads}. A
   * transient thread is a scratch conversation the caller has not chosen to keep; "saving" it
   * clears the flag. Idempotent — promoting an already-persistent thread is a no-op.
   */
  promoteThread(threadId: string): Promise<void>;
  setActiveStream(threadId: string, runId: string | null): Promise<void>;

  /**
   * The `actorRef` that owns a thread, or `null` if no such thread exists. The authorization seam
   * for thread-scoped endpoints (detail / delete / fork): the service compares this against the
   * resolved caller before acting, so one actor can never read or mutate another's thread.
   */
  ownerOfThread(threadId: string): Promise<string | null>;
  /**
   * The `actorRef` that owns the thread a tool call belongs to, or `null` if the call is unknown.
   * The authorization seam for HITL approve / reject: the caller must own the run they approve.
   */
  ownerOfToolCall(toolCallId: string): Promise<string | null>;
  /**
   * The runId currently streaming the thread a tool call belongs to (its thread's `activeStreamId`),
   * or `null` if the call or its active run is unknown. HITL approve / reject route the decision to
   * THIS run, derived server-side from the tool call alone — so a decision reaches the exact run
   * awaiting it, including a sub-agent's own child run, which the client never sees and could not
   * name. No client-supplied runId is trusted (or needed).
   */
  runForToolCall(toolCallId: string): Promise<string | null>;
  /**
   * The `actorRef` that owns the thread currently streaming `runId` (its `activeStreamId`), or
   * `null` if no thread is streaming it. The authorization seam for `cancel`: the caller must own
   * the run they abort. Resolvable during the live window (a run cancel only matters while active).
   */
  ownerOfActiveStream(runId: string): Promise<string | null>;

  appendMessage(input: AppendMessageInput): Promise<StoredMessage>;
  truncateFrom(threadId: string, messageId: string): Promise<void>;

  recordToolCall(input: RecordToolCallInput): Promise<void>;
  updateToolCall(input: UpdateToolCallInput): Promise<void>;

  recordUsage(input: RecordUsageInput): Promise<void>;
  /**
   * The actor's spend for `day` (UTC): total tokens plus the summed provider-reported USD cost.
   * `costUsd` is `0` when no turn on that day reported a cost (token-only providers). Feeds both
   * quota enforcement (via {@link QuotaStore}) and the quota-today view.
   */
  quotaToday(actorRef: string, day: string): Promise<{ usedTokens: number; costUsd: number }>;
}
