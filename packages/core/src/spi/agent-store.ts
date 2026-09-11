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
  /**
   * The run (turn) that produced this message. Without it a consumer can only guess which turn a
   * message belongs to by comparing timestamps against the run's `startedAt`, and that guess breaks
   * the moment a turn is regenerated — the replaced answer is truncated away, so the times no longer
   * line up 1:1. Optional so a caller predating this (and a host that appends messages outside a
   * run) can omit it; the store persists it as `null` when absent.
   */
  runId?: string;
}

export interface RecordToolCallInput {
  toolCallId: string;
  messageId: string;
  toolName: string;
  toolType: 'read' | 'action';
  input: unknown;
  status: ToolCallStatus;
  /**
   * The run (turn) this tool call belongs to — enables a governance surface to deep-link a tool
   * call out to its trace waterfall. Optional so a caller predating this (or a store's own
   * synthetic tool calls) can omit it; the store persists it as `null` when absent.
   */
  runId?: string;
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
  /** sha256 hex of the run's resolved (pre-RAG) system prompt — identifies the prompt VERSION. */
  promptHash?: string;
}

export interface RecordRunEndInput {
  runId: string;
  /**
   * `cancelled` is a THIRD terminal, not a flavour of `failed`: someone asked the run to stop and it
   * did, which is the control working. A consumer computing a failure rate over these rows has to be
   * able to leave it out — counting a user pressing Stop as an error pages whoever is on call for
   * model failures. It carries no `errorCode`/`errorMessage`, since there is nothing to diagnose.
   */
  status: 'completed' | 'failed' | 'cancelled';
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
   * The run awaiting a decision on `toolCallId`: the call's OWN `runId` when the row carries one,
   * else the thread's `activeStreamId`. Both HITL approve/reject and an elicitation answer route
   * through this, derived server-side from the tool call alone — so a decision reaches the exact run
   * awaiting it, including a sub-agent's own child run, which the client never sees and could not
   * name. No client-supplied runId is trusted (or needed).
   *
   * The row's own runId comes FIRST because `activeStreamId` names whichever run is streaming the
   * thread right now, and that is only the same run while a thread holds exactly one. The fallback
   * is for rows written before tool calls recorded a runId, which have nothing else to answer with.
   */
  runForToolCall(toolCallId: string): Promise<string | null>;
  /**
   * The `actorRef` that owns the thread currently streaming `runId` (its `activeStreamId`), or
   * `null` if no thread is streaming it. The authorization seam for `cancel`: the caller must own
   * the run they abort. Resolvable during the live window (a run cancel only matters while active).
   */
  ownerOfActiveStream(runId: string): Promise<string | null>;

  appendMessage(input: AppendMessageInput): Promise<StoredMessage>;
  /**
   * Attach a turn's settled tool RESULTS to a message that was already appended, replacing whatever
   * it held. A message's tool calls are known when it is written and their outputs are not, but a
   * thread reader pairs the two off THAT MESSAGE — so an output that only ever reaches the tool-call
   * table leaves every call on a reopened thread looking like a tool still running.
   *
   * Required rather than optional: a store that silently declines this renders a finished turn as a
   * permanently in-flight one, with nothing logged and nothing to notice. A missing method should
   * fail to compile instead.
   */
  setMessageToolResults(messageId: string, results: ToolResult[]): Promise<void>;
  truncateFrom(threadId: string, messageId: string): Promise<void>;

  recordToolCall(input: RecordToolCallInput): Promise<void>;
  updateToolCall(input: UpdateToolCallInput): Promise<void>;

  /**
   * OPTIONAL: of `mediaIds`, the ones a message that still exists — in a thread owned by
   * `actorRef` — still carries as an attachment. The inverse of
   * {@link import('./attachment-staging.js').AttachmentStagingStore.list}: the host can enumerate
   * the media it staged but cannot see a transcript, and this side sees every transcript but never
   * holds the bytes, so neither can decide alone what is safe to delete.
   *
   * DERIVED, not tracked. A reference is not permanent: `truncateFrom` deletes messages — which is
   * exactly what regenerating a turn does — so media that was referenced becomes unreferenced
   * again. A flag set when a message is sent would never be unset by that delete, and the bytes
   * would be pinned for ever with nothing pointing at them. Answering from the surviving message
   * rows on every call is the only form of this that stays true after a truncation.
   *
   * Scoped to one actor, like every other read on this surface: media referenced only by ANOTHER
   * actor's thread is reported unreferenced here, so this can never be turned into a probe for what
   * exists in someone else's conversation. A host pairs it with its own per-actor inventory, so the
   * candidate ids are already the caller's own.
   *
   * Returns each id at most once, in the order asked. Absent on a store that predates this — a
   * caller must treat the absence as "cannot answer" and collect NOTHING, never as "nothing is
   * referenced", which would delete every attachment the actor ever sent.
   */
  referencedMediaIds?(actorRef: string, mediaIds: readonly string[]): Promise<string[]>;

  recordUsage(input: RecordUsageInput): Promise<void>;
  /**
   * The actor's spend for `day` (UTC): total tokens plus the summed provider-reported USD cost.
   * `costUsd` is `0` when no turn on that day reported a cost (token-only providers). Feeds both
   * quota enforcement (via {@link QuotaStore}) and the quota-today view.
   */
  quotaToday(actorRef: string, day: string): Promise<{ usedTokens: number; costUsd: number }>;
}
