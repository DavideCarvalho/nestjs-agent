import type {
  Actor,
  MessageAttachment,
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
  /** Files the user attached to this message (image/PDF). Persisted verbatim. */
  attachments?: MessageAttachment[];
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

/** Patch applied by {@link AgentStore.updateThread}. An omitted key leaves that field untouched. */
export interface UpdateThreadInput {
  title?: string;
  /** `null` clears the thread's default agent (falls back to the module default). */
  defaultAgent?: string | null;
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

export interface RecordRunStartInput {
  runId: string;
  threadId: string;
  actorRef: string;
  agentName?: string;
}

export interface RecordRunEndInput {
  runId: string;
  status: 'completed' | 'failed';
  durationMs?: number;
  errorCode?: string;
  errorMessage?: string;
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
   * OPTIONAL: rename a thread and/or set its default agent in one write. Absent on a store that
   * predates this — `setTitle` still covers title-only edits, so nothing else in the lib requires
   * this method; the REST `PATCH /threads/:id` endpoint responds 501 for a `defaultAgent` change
   * against a store that lacks it.
   */
  updateThread?(threadId: string, patch: UpdateThreadInput): Promise<void>;
  /**
   * OPTIONAL: the runId of a currently-running turn on this thread, or `null` if none is running.
   * Lets a client that reconnects (page refresh) discover a run to reattach to via the existing
   * `GET /chat/:runId/stream`, instead of only being told about a run right after starting it.
   * Absent on a store that predates this — thread read/list payloads report `activeRunId: null`.
   */
  activeRunForThread?(threadId: string): Promise<string | null>;
  /**
   * OPTIONAL: persist the start of a run (turn). Replay-safe: called under a durable localStep.
   * Absent on a store that predates run recording — reliability metrics degrade to zeros/empty.
   */
  recordRunStart?(run: RecordRunStartInput): Promise<void>;
  /** OPTIONAL: settle a run's outcome. `errorCode`/`errorMessage` only when status is 'failed'. */
  recordRunEnd?(end: RecordRunEndInput): Promise<void>;
  /** OPTIONAL: bump the run's llm-step retry counter (dispatched-step attempt > 1). */
  bumpRunRetries?(runId: string): Promise<void>;

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
