import {
  type QueryKey,
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQueries,
  useSuspenseQuery,
} from '@tanstack/react-query';
import {
  type ApprovalDecisionInput,
  type ApprovalWhere,
  type GovernanceRange,
  type RunWhere,
  type ThreadWhere,
  type ToolCallWhere,
  type UpsertModelPriceInput,
  agentClient,
} from '../client/agent-client';

/**
 * Freshness, not polling.
 *
 * The console used to set one `refetchInterval: 5000` on the QueryClient, so every mounted query
 * re-hit the API every five seconds whether or not anyone was looking, and whether or not the
 * numbers could plausibly have moved. It is gone. What replaces it is `staleTime` per query plus
 * react-query's own defaults — chiefly `refetchOnWindowFocus`, which the old config had turned OFF
 * and which is exactly the behaviour an ops console wants: fresh the moment someone looks at it,
 * silent when the tab is in the background.
 *
 * `refetchOnWindowFocus` only refetches queries that are STALE, so these numbers ARE the cadence.
 */
export const STALE = {
  /**
   * Day-range aggregates (spend, reliability, per-tool rollups). These summarise up to 30 days; a
   * minute of new traffic moves them by a rounding error, and every one of them fans out to several
   * aggregate queries server-side.
   */
  aggregate: 60_000,
  /** Recent-activity lists and paged tables — someone watching these wants "recently", not "now". */
  activity: 15_000,
  /**
   * The HITL approvals queue. Always stale: this is a queue of humans waiting on a human, and the
   * cost of showing a decided row for a minute is an operator deciding it twice.
   */
  queue: 0,
  /** Configuration. Prices change when someone edits them, and that edit invalidates this itself. */
  config: 5 * 60_000,
  /** A drill-down is a snapshot of something that already happened. */
  detail: 30_000,
} as const;

// ─── Section-spine reads (Suspense) ─────────────────────────────────────────
//
// These use `useSuspenseQuery`: the section cannot render a single meaningful pixel without them,
// so "loading" is a section-level skeleton and "failed" is the section's error boundary. That is
// deliberate rather than uniform — the paged tables below stay on `useQuery`, because
// `useSuspenseQuery` has no `placeholderData`, and a table that unmounts into a fallback on every
// page click is a worse table.
//
// SUSPENSE READS WATERFALL. This is not a theory: with two `useSuspenseQuery` calls in one
// component, the first throws, the render unwinds, and the second never runs — loading the Spend
// section against a dead API issued `spend` twice (one retry) and `top-threads` zero times. Two
// reads of equal standing therefore go through `useSuspenseQueries`, which starts both in one pass.
//
// What remains, and is accepted: a container whose SPINE suspends does not start its paged tables
// until the spine resolves — one extra round trip on Reliability and Runs & tools. Removing it
// would mean giving those sections no suspending read at all, which trades one hop for the silent
// failure this whole change exists to delete.

/** Query options for the spend overview — shared so the parallel and solo readers cannot drift. */
function spendQuery(range: GovernanceRange) {
  return {
    queryKey: ['spend', range.fromDay, range.toDay],
    queryFn: () => agentClient.spend(range),
    staleTime: STALE.aggregate,
  } as const;
}

/**
 * The spend overview for a range. Suspends; errors reach the section boundary. Used on its own by
 * the Models and Actors sections, which render one slice of the same payload — same key, so the
 * cache serves all three and moving between them costs nothing.
 */
export function useSpend(range: GovernanceRange) {
  return useSuspenseQuery(spendQuery(range));
}

/**
 * The Spend section's two reads, issued together. See the waterfall note above — this exists
 * because calling `useSpend` and a second suspense hook side by side silently serialises them.
 */
export function useSpendSection(range: GovernanceRange, topThreadsLimit = 10) {
  const [spend, topThreads] = useSuspenseQueries({
    queries: [
      spendQuery(range),
      {
        queryKey: ['top-threads', range.fromDay, range.toDay, topThreadsLimit],
        queryFn: () => agentClient.topThreads(range, topThreadsLimit),
        staleTime: STALE.aggregate,
      },
    ],
  });
  return { overview: spend.data, topThreads: topThreads.data };
}

/** The run-reliability overview for a range. Suspends. */
export function useReliability(range: GovernanceRange) {
  return useSuspenseQuery({
    queryKey: ['reliability', range.fromDay, range.toDay],
    queryFn: () => agentClient.reliability(range),
    staleTime: STALE.aggregate,
  });
}

/** The per-tool call/failure/rejection/latency rollup for a range. Suspends. */
export function useToolStats(range: GovernanceRange) {
  return useSuspenseQuery({
    queryKey: ['tool-stats', range.fromDay, range.toDay],
    queryFn: () => agentClient.toolStats(range),
    staleTime: STALE.aggregate,
  });
}

/** The recent tool-calls feed that backs the denied/forbidden banner. Suspends. */
export function useToolCalls(limit = 50) {
  return useSuspenseQuery({
    queryKey: ['tool-calls', limit],
    queryFn: () => agentClient.toolCalls(limit),
    staleTime: STALE.activity,
  });
}

// ─── Paged tables (plain useQuery + keepPreviousData) ───────────────────────

/**
 * A page of the recent-runs table, filtered by `where`. `page`/`where` drive the query key, so a
 * page change or a filter change refetches; `keepPreviousData` avoids a loading flash between pages.
 */
export function useRunsPage(page: number, pageSize: number, where: RunWhere) {
  return useQuery({
    queryKey: ['runs-page', page, pageSize, where],
    queryFn: () => agentClient.runsPage({ page, pageSize, where }),
    placeholderData: keepPreviousData,
    staleTime: STALE.activity,
  });
}

/** A page of the tool-calls table, filtered by `where`. See {@link useRunsPage}. */
export function useToolCallsPage(page: number, pageSize: number, where: ToolCallWhere) {
  return useQuery({
    queryKey: ['tool-calls-page', page, pageSize, where],
    queryFn: () => agentClient.toolCallsPage({ page, pageSize, where }),
    placeholderData: keepPreviousData,
    staleTime: STALE.activity,
  });
}

/** A page of the threads table, filtered by `where`. See {@link useRunsPage}. */
export function useThreadsPage(page: number, pageSize: number, where: ThreadWhere) {
  return useQuery({
    queryKey: ['threads-page', page, pageSize, where],
    queryFn: () => agentClient.threadsPage({ page, pageSize, where }),
    placeholderData: keepPreviousData,
    staleTime: STALE.activity,
  });
}

/**
 * A page of the cross-thread approvals inbox, with the backlog `total`. Replaces `GET approvals`
 * for the inbox itself: the unpaged read is capped at 50 with no total, so a 51st pending decision
 * was invisible and nothing on screen said so.
 */
export function useApprovalsPage(page: number, pageSize: number, where: ApprovalWhere) {
  return useQuery({
    queryKey: ['approvals-page', page, pageSize, where],
    queryFn: () => agentClient.approvalsPage({ page, pageSize, where }),
    placeholderData: keepPreviousData,
    staleTime: STALE.queue,
  });
}

/**
 * The pending-approval backlog SIZE, for the nav badge — the one number that has to be true while
 * the operator is looking at some other section, so it is the one query the shell keeps mounted.
 *
 * `pageSize: 1` because only `total` is read; the single row that comes back is the price of the
 * endpoint not having a count-only form. Its key is deliberately NOT a prefix of `approvals-page`,
 * so paging the inbox never evicts the badge and vice versa.
 *
 * **This is the one query that still polls, and it is the one that has to.** Everything else here
 * refetches on focus, which is right for a number an operator reads when they look at it. This badge
 * is the opposite: its whole job is to be true while they are looking somewhere else, so
 * focus-driven refetching cannot reach it — an approval arriving while the tab is in the background
 * would sit invisible until someone happened to come back.
 *
 * The obvious alternative is to invalidate it from the live SSE stream, and that does not work
 * today: no event is published when a tool call enters `pending_approval`. `agent-loop.ts` persists
 * that status through a plain `hooks.step(...)`, the `tool.execution` span wraps the execution that
 * only happens *after* approval, and `publishAgentToolCall` fires on the decision. The stream simply
 * does not carry the moment this number changes. Making it live properly means publishing a new
 * event at that persist — a change in `core`'s agent loop, worth doing, but not a client-side
 * follow-up and not something to pretend is already possible.
 *
 * 20s rather than the old global 5s: this is one indexed count, not the eleven-query fan-out that
 * interval used to drive, and 20 seconds of latency on a queue that waits for a human to walk over
 * and read it is not the bottleneck.
 */
export function useApprovalsCount() {
  return useQuery({
    queryKey: ['approvals-count'],
    queryFn: async () => (await agentClient.approvalsPage({ page: 1, pageSize: 1 })).total,
    staleTime: STALE.queue,
    refetchInterval: 20_000,
    // Keep counting while the operator is in another tab — that is the entire point of this query.
    refetchIntervalInBackground: true,
  });
}

// ─── Drill-downs ────────────────────────────────────────────────────────────

/**
 * One run with its thread and its tool calls. Plain `useQuery`, not suspense: a drill-down has three
 * outcomes an operator must be able to tell apart — loading, `404` (the run is gone), and everything
 * else — and a boundary can only render the third.
 */
export function useRunDetail(runId: string) {
  return useQuery({
    queryKey: ['run-detail', runId],
    queryFn: () => agentClient.runDetail(runId),
    staleTime: STALE.detail,
  });
}

/** One thread with its usage rollup, newest runs and newest messages. See {@link useRunDetail}. */
export function useThreadDetail(threadId: string) {
  return useQuery({
    queryKey: ['thread-detail', threadId],
    queryFn: () => agentClient.threadDetail(threadId),
    staleTime: STALE.detail,
  });
}

// ─── Configuration ──────────────────────────────────────────────────────────

/**
 * The current-prices list. Plain `useQuery` on purpose: this endpoint `501`s when the host bound no
 * `AGENT_PRICING_STORE`, and that is a deployment posture the section renders as its own state — not
 * an outage. Routing it to an error boundary would tell an operator something is broken when
 * nothing is.
 */
export function usePricing() {
  return useQuery({
    queryKey: ['pricing'],
    queryFn: () => agentClient.pricing(),
    staleTime: STALE.config,
  });
}

// ─── Mutations ──────────────────────────────────────────────────────────────

/**
 * Everything a decided approval changes. The old code invalidated `['approvals']` alone; the five-
 * second poll hid the rest, so removing the poll is what makes this list load-bearing.
 *
 * A decision flips that tool call's `status`, and the status is also what `tool-calls` (the
 * denied/forbidden banner), `tool-calls-page` and any open `run-detail` render. A rejection also
 * increments the tool's `rejected` count in `tool-stats`.
 *
 * NOT invalidated: `reliability` and `runs-page`. The decision unblocks a run that finishes later
 * on its own schedule, so invalidating them here would refetch a run status that has not changed
 * yet — the honest refresh for those is the operator's next focus or nav.
 */
const APPROVAL_DEPENDENTS: QueryKey[] = [
  ['approvals'],
  ['approvals-page'],
  ['approvals-count'],
  ['tool-calls'],
  ['tool-calls-page'],
  ['tool-stats'],
  ['run-detail'],
];

/** Decide a pending HITL tool call, refreshing every read the decision moves. */
export function useDecideApproval() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ toolCallId, input }: { toolCallId: string; input: ApprovalDecisionInput }) =>
      agentClient.decideApproval(toolCallId, input),
    onSuccess: () => {
      for (const queryKey of APPROVAL_DEPENDENTS) {
        queryClient.invalidateQueries({ queryKey });
      }
    },
  });
}

/**
 * Everything a price edit changes. More than the pricing table, because cost is priced at READ time:
 * `governance/compute.ts` falls back to `estimateCost(row, prices.get(row.modelId))` for every
 * ledger row with no provider-reported cost, so editing a rate retroactively restates historical
 * spend. Every surface carrying a dollar figure has to be refetched, or the console shows the new
 * rate next to totals computed from the old one.
 */
const PRICE_DEPENDENTS: QueryKey[] = [['pricing'], ['spend'], ['top-threads'], ['thread-detail']];

/** Upsert a model's current price, refreshing the price table and every cost figure derived from it. */
export function useUpsertPrice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpsertModelPriceInput) => agentClient.upsertPrice(input),
    onSuccess: () => {
      for (const queryKey of PRICE_DEPENDENTS) {
        queryClient.invalidateQueries({ queryKey });
      }
    },
  });
}
