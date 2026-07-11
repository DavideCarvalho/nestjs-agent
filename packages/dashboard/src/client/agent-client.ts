// Typed API client for the AI-gateway console. Self-contained: the row shapes are re-declared here
// (identical to core's `AgentGovernanceQueries` contract) so `@dudousxd/nestjs-agent-dashboard/client`
// is dependency-free for an external front-end that only wants to call the API.

/** Inclusive UTC day range, each `YYYY-MM-DD`. */
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
}

/** Body for `POST <api>/approvals/:toolCallId` — decide a pending HITL tool call. */
export interface ApprovalDecisionInput {
  approved: boolean;
  reason?: string;
}

/** Governance rollup for one tool over a range, for the Tools section. */
export interface ToolStatRow {
  toolName: string;
  toolType: string;
  calls: number;
  failed: number;
  rejected: number;
  /** p95 of executionMs across executed calls; null when none carry it. */
  p95ExecutionMs: number | null;
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
  /** Tool calls sitting `pending_approval`, oldest first (default 50) — the approvals inbox. */
  approvals(limit = 50): Promise<PendingApprovalRow[]> {
    return http<PendingApprovalRow[]>(`/approvals?limit=${limit}`);
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
