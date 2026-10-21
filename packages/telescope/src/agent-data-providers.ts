import type { DataProvider, ExtensionContext } from '@dudousxd/nestjs-telescope';
import { TELESCOPE_STORAGE } from '@dudousxd/nestjs-telescope';

export interface AgentEntryContent {
  event: string;
  runId?: string;
  threadId?: string;
  toolName?: string;
  toolType?: string;
  status?: string;
  steps?: number;
  inputTokens?: number;
  outputTokens?: number;
  /** `run.finished`: turn start to the first `text` frame. */
  ttftMs?: number;
  /** `run.finished`: present on a delegated sub-agent's run. */
  parentRunId?: string;
  /** `run.failed`: the stable stream error code. */
  code?: string;
  /** `tool-call`: an outcome re-published by a run replaying its journal. */
  replayed?: boolean;
}

export interface StorageEntry {
  content?: AgentEntryContent;
  createdAt?: Date;
}

async function fetchEntries(ctx: ExtensionContext): Promise<StorageEntry[]> {
  const storage = ctx.moduleRef.get(TELESCOPE_STORAGE, { strict: false }) as {
    get(query: { type?: string; limit?: number }): Promise<{ data: StorageEntry[] }>;
  };
  const page = await storage.get({ type: 'agent', limit: 5_000 });
  return page.data;
}

function ofEvent(entries: StorageEntry[], event: string): StorageEntry[] {
  return entries.filter((entry) => entry.content?.event === event);
}

/**
 * `tool-call` entries minus the re-publications of a replaying run. A durable run re-publishes every
 * outcome it already settled each time it replays its journal (`replayed: true`); counting those
 * would multiply a call by the number of times its run resumed.
 */
function firstToolCalls(entries: StorageEntry[]): StorageEntry[] {
  return ofEvent(entries, 'tool-call').filter((entry) => entry.content?.replayed !== true);
}

/** Nearest-rank percentile over an unsorted sample. `null` for an empty sample. */
function percentileOf(samples: number[], fraction: number): number | null {
  if (samples.length === 0) {
    return null;
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil(fraction * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1] ?? null;
}

/**
 * Fixed time-to-first-token ladder, in milliseconds — fixed for the same reason as the retrieval
 * latency ladder: a histogram whose bins move between refreshes cannot be compared with the last one.
 * Wider than retrieval's, since a first token waits on a model (and on the turn's tools before it).
 */
const TTFT_EDGES = [250, 500, 1_000, 2_000, 4_000, 8_000, 16_000];

function ttftLabel(index: number): string {
  const upper = TTFT_EDGES[index];
  if (upper === undefined) {
    return `≥${TTFT_EDGES[TTFT_EDGES.length - 1] ?? 0}ms`;
  }
  return `${index === 0 ? 0 : (TTFT_EDGES[index - 1] ?? 0)}–${upper}ms`;
}

/**
 * Time-to-first-token histogram over the recorded `run.finished` entries, plus p50/p95 of the raw
 * samples. Top-level runs only — a delegated sub-agent streams into its parent's turn, so its first
 * token is not one a person waited for (the same rule `RunMetrics.ttftP50Ms` applies). A run that
 * streamed no text carries no `ttftMs` and is left out rather than counted as `0`.
 */
export function toTtftDistribution(entries: StorageEntry[]): {
  buckets: { label: string; count: number }[];
  p50?: number;
  p95?: number;
} {
  const samples: number[] = [];
  const counts = new Array<number>(TTFT_EDGES.length + 1).fill(0);
  for (const entry of ofEvent(entries, 'run.finished')) {
    const ttftMs = entry.content?.ttftMs;
    if (typeof ttftMs !== 'number' || entry.content?.parentRunId !== undefined) {
      continue;
    }
    samples.push(ttftMs);
    const found = TTFT_EDGES.findIndex((edge) => ttftMs < edge);
    const index = found === -1 ? TTFT_EDGES.length : found;
    counts[index] = (counts[index] ?? 0) + 1;
  }
  const buckets = counts.map((count, index) => ({ label: ttftLabel(index), count }));
  const p50 = percentileOf(samples, 0.5);
  const p95 = percentileOf(samples, 0.95);
  return {
    buckets,
    ...(p50 !== null ? { p50 } : {}),
    ...(p95 !== null ? { p95 } : {}),
  };
}

/** Failed runs by their stable error code, over the recorded `run.failed` entries. */
export function toFailureCodeSegments(entries: StorageEntry[]): { label: string; value: number }[] {
  const counts = new Map<string, number>();
  for (const entry of ofEvent(entries, 'run.failed')) {
    const code = entry.content?.code ?? 'unknown';
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value);
}

/** stat → total agent runs (run.finished entries). */
export function agentRunsProvider(): DataProvider {
  return {
    name: 'agent.runs',
    async resolve(_query, ctx) {
      const finished = ofEvent(await fetchEntries(ctx), 'run.finished');
      return { value: finished.length };
    },
  };
}

/** stat → total tokens across all finished runs. */
export function agentTokensProvider(): DataProvider {
  return {
    name: 'agent.tokens',
    async resolve(_query, ctx) {
      const finished = ofEvent(await fetchEntries(ctx), 'run.finished');
      const value = finished.reduce(
        (sum, entry) =>
          sum + (entry.content?.inputTokens ?? 0) + (entry.content?.outputTokens ?? 0),
        0,
      );
      return { value };
    },
  };
}

/**
 * table → recent tool calls, from Telescope's own ephemeral event storage.
 *
 * @deprecated Superseded in the shipped dashboard by `agentRecentToolCallsTableProvider`
 * (`agent.tools.recent`, in `agent-governance-providers.ts`), which reads the durable,
 * restart-surviving `AGENT_GOVERNANCE_QUERIES.recentToolCalls` read-model. That durable route is
 * never behind this ephemeral one: `agent-loop.ts` always awaits `store.recordToolCall` /
 * `store.updateToolCall` (the durable write) BEFORE calling `publishAgentToolCall` (the event this
 * provider reads), so a row is durably queryable strictly before the ephemeral entry exists. The
 * durable route also captures the `pending_approval` state this ephemeral channel never emits at
 * all (no `publishAgentToolCall` call sits between `recordToolCall(status: 'pending_approval')`
 * and the eventual terminal transition) — so there's no in-flight state left for this table to
 * uniquely show. Kept exported (not removed — that would be a breaking export change) for hosts
 * that use `agentTelescopeExtension()` without wiring `AGENT_GOVERNANCE_QUERIES`, or that compose
 * a custom extension from these lower-level provider functions directly.
 */
export function agentToolsProvider(): DataProvider {
  return {
    name: 'agent.tools',
    async resolve(_query, ctx) {
      const calls = firstToolCalls(await fetchEntries(ctx))
        .slice(-50)
        .reverse()
        .map((entry) => ({
          toolName: entry.content?.toolName ?? '',
          toolType: entry.content?.toolType ?? '',
          status: entry.content?.status ?? '',
          runId: entry.content?.runId ?? '',
        }));
      return { rows: calls };
    },
  };
}

/** breakdown → tool-call status distribution. */
export function agentToolStatusProvider(): DataProvider {
  return {
    name: 'agent.toolStatus',
    async resolve(_query, ctx) {
      const calls = firstToolCalls(await fetchEntries(ctx));
      const counts = new Map<string, number>();
      for (const call of calls) {
        const status = call.content?.status ?? 'unknown';
        counts.set(status, (counts.get(status) ?? 0) + 1);
      }
      return { segments: [...counts.entries()].map(([label, value]) => ({ label, value })) };
    },
  };
}

/**
 * distribution → time to first token of the recorded top-level runs, from the `run.finished`
 * diagnostics this extension's watcher keeps. Unlike the governance duration pair, these entries
 * carry the raw per-run figure, so there ARE samples to bucket — at the cost of covering only what
 * Telescope's own storage still holds.
 */
export function agentRunsTtftDistributionProvider(): DataProvider {
  return {
    name: 'agent.runs.ttftDistribution',
    async resolve(_query, ctx) {
      return toTtftDistribution(await fetchEntries(ctx));
    },
  };
}

/**
 * breakdown → failed runs by error code, from the recorded `run.failed` diagnostics. Needs no store:
 * the governance `agent.runs.errors` donut answers the same question over the range from the run
 * rows, and this one keeps answering it for a host that records none.
 */
export function agentRunFailureCodesProvider(): DataProvider {
  return {
    name: 'agent.runs.failureCodes',
    async resolve(_query, ctx) {
      return { segments: toFailureCodeSegments(await fetchEntries(ctx)) };
    },
  };
}

/** stat → runs someone stopped (`run.cancelled` entries) — kept apart from failures on purpose. */
export function agentRunsCancelledProvider(): DataProvider {
  return {
    name: 'agent.runs.cancelled',
    async resolve(_query, ctx) {
      return { value: ofEvent(await fetchEntries(ctx), 'run.cancelled').length };
    },
  };
}
