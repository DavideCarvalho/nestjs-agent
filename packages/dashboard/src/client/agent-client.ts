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
}

/** Spend + token totals for one thread over a range. */
export interface ThreadSpendRow {
  threadId: string;
  title: string;
  actorRef: string;
  requests: number;
  totalTokens: number;
  costUsd: number;
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
  /** Most recent tool calls (default 50). */
  toolCalls(limit = 50): Promise<ToolCallActivityRow[]> {
    return http<ToolCallActivityRow[]>(`/tool-calls?limit=${limit}`);
  },
  /** Most recent threads (default 50). */
  threads(limit = 50): Promise<ThreadActivityRow[]> {
    return http<ThreadActivityRow[]>(`/threads?limit=${limit}`);
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
