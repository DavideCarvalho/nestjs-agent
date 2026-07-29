// Typed API client for the AI-gateway console. Self-contained: the row shapes are re-declared here
// (identical to core's `AgentGovernanceQueries` contract) so `@dudousxd/nestjs-agent-dashboard/client`
// is dependency-free for an external front-end that only wants to call the API.

/** Inclusive UTC day range, each `YYYY-MM-DD`. */
// Headless console-launcher primitives (path derivation + mint-then-navigate). Re-exported here
// because `./client` resolves to this file — see the package's `exports` map.
export {
  ConsoleSessionError,
  agentConsoleSessionUrl,
  agentConsoleUrl,
  mintAgentConsoleSession,
  openAgentConsole,
  type OpenConsoleOptions,
} from './console-session.js';

export interface GovernanceRange {
  fromDay: string;
  toDay: string;
}

/** Spend + token totals for one model over a range. */
export interface ModelSpendRow {
  modelId: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/** Spend + token totals for one acting ref (user/tenant) over a range. */
export interface ActorSpendRow {
  actorRef: string;
  requests: number;
  totalTokens: number;
  costUsd: number;
  /** Human-readable label resolved from `actorRef` (an `ActorDirectory`), when one is bound server-side. */
  actorLabel: string | null;
}

/** Spend + token totals for one thread over a range. */
export interface ThreadSpendRow {
  threadId: string;
  title: string;
  actorRef: string;
  requests: number;
  totalTokens: number;
  costUsd: number;
  /** Human-readable label resolved from `actorRef` (an `ActorDirectory`), when one is bound server-side. */
  actorLabel: string | null;
}

/** One point on the daily usage/cost trend. */
export interface UsageTrendPoint {
  day: string;
  totalTokens: number;
  costUsd: number;
}

/** A recent tool-call for the activity feed. */
export interface ToolCallActivityRow {
  toolCallId: string;
  toolName: string;
  toolType: string;
  status: string;
  threadId: string;
  createdAt: string;
  /** The run this call belongs to, for a trace deep-link; `null` for a call recorded before this shipped. */
  runId: string | null;
}

/** A recent thread with rolled-up activity. */
export interface ThreadActivityRow {
  threadId: string;
  title: string;
  actorRef: string;
  messageCount: number;
  totalTokens: number;
  lastActivityAt: string;
  /** Human-readable label resolved from `actorRef` (an `ActorDirectory`), when one is bound server-side. */
  actorLabel: string | null;
}

/** Aggregated run reliability over a range. */
export interface RunMetrics {
  runs: number;
  completed: number;
  failed: number;
  /** completed / runs, 0 when runs = 0. */
  successRate: number;
  /** Total llm-step retries across the range's runs. */
  retries: number;
  durationP50Ms: number | null;
  durationP95Ms: number | null;
}

/** Run/failure counts for one agent over a range. */
export interface RunAgentBreakdownRow {
  agentName: string;
  runs: number;
  failed: number;
  retries: number;
}

/** Failure count for one error code over a range. */
export interface RunErrorBreakdownRow {
  errorCode: string;
  count: number;
}

/** One point on the daily run/failure trend. */
export interface RunTrendPoint {
  day: string;
  runs: number;
  failed: number;
}

/** A recent run for the Reliability recent-runs table. */
export interface RecentRunRow {
  runId: string;
  threadId: string;
  actorRef: string;
  agentName: string | null;
  status: string;
  durationMs: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  retries: number;
  startedAt: string;
  /** sha256 hex of the run's resolved (pre-RAG) system prompt; `null` for a run recorded before this shipped. */
  promptHash: string | null;
}

/** One tool call awaiting a HITL decision, for the cross-thread approvals inbox. */
export interface PendingApprovalRow {
  toolCallId: string;
  toolName: string;
  input: unknown;
  threadId: string;
  threadTitle: string;
  /** Who asked — the run's actor. */
  actorRef: string;
  agentName: string | null;
  /** ISO timestamp. */
  requestedAt: string;
  /** The run this call belongs to, for a trace deep-link; `null` for a pre-rollout row. */
  runId: string | null;
}

/** Body for `POST <api>/approvals/:toolCallId` — decide a pending HITL tool call. */
export interface ApprovalDecisionInput {
  approved: boolean;
  reason?: string;
}

/** Neutral paged query for the governance list reads (mirrors core's `GovernancePageQuery`). */
export interface GovernancePageQuery<TWhere> {
  /** 1-based. */
  page: number;
  /** Rows per page, clamped server-side to 1..200. */
  pageSize: number;
  /** Equality/range filters; absent field = no constraint. */
  where?: TWhere;
}

/** One page of a governance list read (mirrors core's `GovernancePage`). */
export interface GovernancePage<TRow> {
  rows: TRow[];
  total: number;
  page: number;
  pageSize: number;
}

/** Filters for `GET tool-calls-page` (the Runs & tools tool-calls table). */
export interface ToolCallWhere {
  toolName?: string;
  toolType?: string;
  status?: string;
  threadId?: string;
  /** Inclusive UTC day bounds, `YYYY-MM-DD`. */
  fromDay?: string;
  toDay?: string;
}

/** Filters for `GET threads-page` (the Runs & tools threads table). */
export interface ThreadWhere {
  actorRef?: string;
  /** Substring match on the title (case-insensitive). */
  title?: string;
  fromDay?: string;
  toDay?: string;
}

/** Filters for `GET runs-page` (the Reliability recent-runs table). */
export interface RunWhere {
  agentName?: string;
  status?: string;
  errorCode?: string;
  /** Every run on one thread — the follow-up query a drill-down leads to. */
  threadId?: string;
  fromDay?: string;
  toDay?: string;
}

/** Filters for `GET approvals-page` (the paged approvals inbox). */
export interface ApprovalWhere {
  toolName?: string;
  threadId?: string;
  /** The requesting thread's owner. */
  actorRef?: string;
  agentName?: string;
  /** Inclusive UTC day bounds on when the approval was requested, `YYYY-MM-DD`. */
  fromDay?: string;
  toDay?: string;
}

/** Governance rollup for one tool over a range, for the Tools section. */
export interface ToolStatRow {
  toolName: string;
  toolType: string;
  calls: number;
  failed: number;
  rejected: number;
  /**
   * p50 (median) of executionMs across calls that recorded one; null when none carry it. Paired with
   * p95 rather than a mean — tool latency is long-tailed, so "typical" and "tail" are two numbers.
   */
  p50ExecutionMs: number | null;
  /** p95 of executionMs across executed calls; null when none carry it. */
  p95ExecutionMs: number | null;
}

// ─── Drill-downs ────────────────────────────────────────────────────────────
//
// One request per drill-down, not one per row it renders.

/** One tool call inside a `RunDetail`, with the execution outcome a list row can't afford to carry. */
export interface RunToolCallRow {
  toolCallId: string;
  toolName: string;
  toolType: string;
  status: string;
  /** Wall time of the execution; null for a call that never executed. */
  executionMs: number | null;
  /** Who executed/decided it, when the store recorded an attribution. */
  executedByRef: string | null;
  /** The failure text for a `failed` call; null otherwise. */
  error: string | null;
  createdAt: string;
}

/** The owning thread's headline, carried on a drill-down so it can be named without a second read. */
export interface DetailThreadRef {
  threadId: string;
  title: string;
  actorRef: string;
  /** True when the thread is soft-deleted — its history is still readable, the thread is not. */
  deleted: boolean;
  /** Human-readable label resolved from `actorRef` (an `ActorDirectory`), when one is bound server-side. */
  actorLabel: string | null;
}

/**
 * The `GET <api>/runs/:runId` response. `toolCalls` is empty for a run recorded before tool calls
 * carried a run id — indistinguishable, from here, from a run that called no tools. There is no cost
 * figure: the token ledger has no run column, so per-run spend is not attributable.
 */
export interface RunDetail {
  run: RecentRunRow;
  thread: DetailThreadRef;
  /** The run's tool calls, oldest first — the order they were requested in. */
  toolCalls: RunToolCallRow[];
}

/** One message inside a `ThreadDetail`. `content` is capped server-side. */
export interface ThreadMessageRow {
  messageId: string;
  role: string;
  /** Message text, capped server-side; see `truncated`. */
  content: string;
  /** True when `content` was cut — render an explicit "…" rather than implying the tail. */
  truncated: boolean;
  agentName: string | null;
  /** How many tool calls this message requested. */
  toolCallCount: number;
  createdAt: string;
}

/** Token/cost rollup across a thread's whole ledger (lifetime, not range-scoped). */
export interface ThreadUsageRollup {
  /** Ledger rows, i.e. billed turns. */
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
}

/** The `GET <api>/threads/:threadId` response. */
export interface ThreadDetail {
  /** The thread's activity row (`messageCount` is the thread total, not the `messages` cap below). */
  thread: ThreadActivityRow;
  /** True when the thread is soft-deleted. */
  deleted: boolean;
  usage: ThreadUsageRollup;
  /** The thread's runs, newest first, capped by the `runs` query param. */
  runs: RecentRunRow[];
  /** Runs on this thread in total — `runs.length < runTotal` means the cap bit. */
  runTotal: number;
  /** The thread's messages, newest first, capped by the `messages` query param. */
  messages: ThreadMessageRow[];
}

/** The `GET <api>/reliability` response. */
export interface ReliabilityOverview {
  metrics: RunMetrics;
  byAgent: RunAgentBreakdownRow[];
  errors: RunErrorBreakdownRow[];
  trend: RunTrendPoint[];
}

/** A model's current per-1M-token price (the pricing tab's row shape). */
export interface ModelPrice {
  modelId: string;
  inputPricePer1m: number;
  outputPricePer1m: number;
  cacheWritePricePer1m?: number;
  cacheReadPricePer1m?: number;
  effectiveFrom: string;
}

/** Body for `POST <api>/pricing` — sets a model's current price. */
export interface UpsertModelPriceInput {
  modelId: string;
  inputPricePer1m: number;
  outputPricePer1m: number;
  cacheWritePricePer1m?: number;
  cacheReadPricePer1m?: number;
}

/** The `GET <api>/spend` response. */
export interface SpendOverview {
  byModel: ModelSpendRow[];
  byActor: ActorSpendRow[];
  trend: UsageTrendPoint[];
}

/** One live agent event forwarded over SSE. */
export interface LiveAgentEvent {
  event: string;
  ts: number;
  payload: Record<string, unknown>;
}

declare global {
  interface Window {
    /** UI mount base (e.g. `/ai-gateway`) injected by the UI controller; falls back to `/ai-gateway`. */
    __AGENT_BASE__?: string;
    /** JSON API base (e.g. `/ai-gateway/api`) injected by the UI controller; falls back to `<base>/api`. */
    __AGENT_API__?: string;
  }
}

function apiBase(): string {
  if (typeof window !== 'undefined' && window.__AGENT_API__) return window.__AGENT_API__;
  const base = (typeof window !== 'undefined' && window.__AGENT_BASE__) || '/ai-gateway';
  return `${base}/api`;
}

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(apiBase() + path, init);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

/** `page`/`limit`/`where[field]=value` query params for a paged governance read. */
function pageQueryParams<TWhere extends object>(
  query: GovernancePageQuery<TWhere>,
): URLSearchParams {
  const params = new URLSearchParams({ page: `${query.page}`, limit: `${query.pageSize}` });
  if (query.where !== undefined) {
    for (const [field, value] of Object.entries(query.where)) {
      if (typeof value === 'string' && value !== '') params.set(`where[${field}]`, value);
    }
  }
  return params;
}

export const agentClient = {
  /** Spend/usage overview for a day range: `{ byModel, byActor, trend }`. */
  spend(range: GovernanceRange): Promise<SpendOverview> {
    const q = new URLSearchParams({ from: range.fromDay, to: range.toDay });
    return http<SpendOverview>(`/spend?${q.toString()}`);
  },
  /** Top threads by cost for a day range (default 10). */
  topThreads(range: GovernanceRange, limit = 10): Promise<ThreadSpendRow[]> {
    const q = new URLSearchParams({ from: range.fromDay, to: range.toDay, limit: `${limit}` });
    return http<ThreadSpendRow[]>(`/top-threads?${q.toString()}`);
  },
  /** Run reliability for a day range: `{ metrics, byAgent, errors, trend }`. */
  reliability(range: GovernanceRange): Promise<ReliabilityOverview> {
    const q = new URLSearchParams({ from: range.fromDay, to: range.toDay });
    return http<ReliabilityOverview>(`/reliability?${q.toString()}`);
  },
  /** Most recent runs (default 50). */
  runs(limit = 50): Promise<RecentRunRow[]> {
    return http<RecentRunRow[]>(`/runs?limit=${limit}`);
  },
  /** Most recent tool calls (default 50). */
  toolCalls(limit = 50): Promise<ToolCallActivityRow[]> {
    return http<ToolCallActivityRow[]>(`/tool-calls?limit=${limit}`);
  },
  /** A page of tool calls, filtered by `where` — the Runs & tools tool-calls table. */
  toolCallsPage(
    query: GovernancePageQuery<ToolCallWhere>,
  ): Promise<GovernancePage<ToolCallActivityRow>> {
    return http<GovernancePage<ToolCallActivityRow>>(`/tool-calls-page?${pageQueryParams(query)}`);
  },
  /**
   * Tool calls sitting `pending_approval`, oldest first (default 50) — the approvals inbox.
   *
   * Capped with NO total: a backlog past `limit` is invisible in this response. Prefer
   * {@link agentClient.approvalsPage}, which reports how many are off-screen.
   */
  approvals(limit = 50): Promise<PendingApprovalRow[]> {
    return http<PendingApprovalRow[]>(`/approvals?limit=${limit}`);
  },
  /** A page of the approvals inbox with the backlog `total` — oldest first, filtered by `where`. */
  approvalsPage(
    query: GovernancePageQuery<ApprovalWhere>,
  ): Promise<GovernancePage<PendingApprovalRow>> {
    return http<GovernancePage<PendingApprovalRow>>(`/approvals-page?${pageQueryParams(query)}`);
  },
  /** One run with its thread and its tool calls, in one request. Rejects with `404 …` if unknown. */
  runDetail(runId: string): Promise<RunDetail> {
    return http<RunDetail>(`/runs/${encodeURIComponent(runId)}`);
  },
  /**
   * One thread with its lifetime usage rollup, newest runs and newest messages, in one request.
   * `messages`/`runs` cap the two lists (server clamps to 1..200). Rejects with `404 …` if unknown.
   */
  threadDetail(
    threadId: string,
    opts: { messages?: number; runs?: number } = {},
  ): Promise<ThreadDetail> {
    const q = new URLSearchParams();
    if (opts.messages !== undefined) q.set('messages', `${opts.messages}`);
    if (opts.runs !== undefined) q.set('runs', `${opts.runs}`);
    const suffix = q.size > 0 ? `?${q.toString()}` : '';
    return http<ThreadDetail>(`/threads/${encodeURIComponent(threadId)}${suffix}`);
  },
  /**
   * Decide a pending HITL tool call. 501s (a plain `Error` whose message starts with `501`, like
   * `upsertPrice` below) if the host has no `AGENT_APPROVAL_PORT` bound — the approvals inbox reads
   * that as "render read-only".
   */
  async decideApproval(toolCallId: string, input: ApprovalDecisionInput): Promise<void> {
    const res = await fetch(`${apiBase()}/approvals/${encodeURIComponent(toolCallId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  },
  /** Per-tool call/failure/rejection/latency rollup for a day range (the Tools section). */
  toolStats(range: GovernanceRange): Promise<ToolStatRow[]> {
    const q = new URLSearchParams({ from: range.fromDay, to: range.toDay });
    return http<ToolStatRow[]>(`/tools?${q.toString()}`);
  },
  /** Most recent threads (default 50). */
  threads(limit = 50): Promise<ThreadActivityRow[]> {
    return http<ThreadActivityRow[]>(`/threads?limit=${limit}`);
  },
  /** A page of threads, filtered by `where` — the Runs & tools threads table. */
  threadsPage(query: GovernancePageQuery<ThreadWhere>): Promise<GovernancePage<ThreadActivityRow>> {
    return http<GovernancePage<ThreadActivityRow>>(`/threads-page?${pageQueryParams(query)}`);
  },
  /** A page of runs, filtered by `where` — the Reliability recent-runs table. */
  runsPage(query: GovernancePageQuery<RunWhere>): Promise<GovernancePage<RecentRunRow>> {
    return http<GovernancePage<RecentRunRow>>(`/runs-page?${pageQueryParams(query)}`);
  },
  /** Current price row per model. 501s if the host has no pricing store bound. */
  pricing(): Promise<ModelPrice[]> {
    return http<ModelPrice[]>('/pricing');
  },
  /** Set a model's current price. 501s if the host has no pricing store bound. */
  async upsertPrice(input: UpsertModelPriceInput): Promise<void> {
    const res = await fetch(`${apiBase()}/pricing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  },
  /**
   * Live-tail `aviary:agent:*` events over SSE. Calls `onEvent` per event; returns a function that
   * closes the stream.
   */
  streamEvents(onEvent: (event: LiveAgentEvent) => void): () => void {
    const source = new EventSource(`${apiBase()}/stream`);
    source.onmessage = (msg) => {
      try {
        onEvent(JSON.parse(msg.data) as LiveAgentEvent);
      } catch {
        /* ignore malformed event */
      }
    };
    return () => source.close();
  },
};
