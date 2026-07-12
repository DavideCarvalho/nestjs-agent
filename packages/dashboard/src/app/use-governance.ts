import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type ApprovalDecisionInput,
  type GovernanceRange,
  type RunWhere,
  type ThreadWhere,
  type ToolCallWhere,
  type UpsertModelPriceInput,
  agentClient,
} from '../client/agent-client';

/** Poll the spend overview for a range. Refetches on the QueryClient's default interval. */
export function useSpend(range: GovernanceRange) {
  return useQuery({
    queryKey: ['spend', range.fromDay, range.toDay],
    queryFn: () => agentClient.spend(range),
  });
}

/** Poll the top-threads-by-cost feed for a range. */
export function useTopThreads(range: GovernanceRange, limit = 10) {
  return useQuery({
    queryKey: ['top-threads', range.fromDay, range.toDay, limit],
    queryFn: () => agentClient.topThreads(range, limit),
  });
}

/** Poll the run reliability overview for a range. */
export function useReliability(range: GovernanceRange) {
  return useQuery({
    queryKey: ['reliability', range.fromDay, range.toDay],
    queryFn: () => agentClient.reliability(range),
  });
}

/** Poll the recent-runs feed. */
export function useRuns(limit = 50) {
  return useQuery({
    queryKey: ['runs', limit],
    queryFn: () => agentClient.runs(limit),
  });
}

/** Poll a page of the recent-runs table, filtered by `where`. See {@link useToolCallsPage}. */
export function useRunsPage(page: number, pageSize: number, where: RunWhere) {
  return useQuery({
    queryKey: ['runs-page', page, pageSize, where],
    queryFn: () => agentClient.runsPage({ page, pageSize, where }),
    placeholderData: keepPreviousData,
  });
}

/** Poll the recent tool-calls feed. */
export function useToolCalls(limit = 50) {
  return useQuery({
    queryKey: ['tool-calls', limit],
    queryFn: () => agentClient.toolCalls(limit),
  });
}

/**
 * Poll a page of the tool-calls table, filtered by `where`. `page`/`where` drive the query key, so
 * a page change or a filter change refetches; `keepPreviousData` avoids a loading flash between pages.
 */
export function useToolCallsPage(page: number, pageSize: number, where: ToolCallWhere) {
  return useQuery({
    queryKey: ['tool-calls-page', page, pageSize, where],
    queryFn: () => agentClient.toolCallsPage({ page, pageSize, where }),
    placeholderData: keepPreviousData,
  });
}

/** Poll the recent threads feed. */
export function useThreads(limit = 50) {
  return useQuery({
    queryKey: ['threads', limit],
    queryFn: () => agentClient.threads(limit),
  });
}

/** Poll a page of the threads table, filtered by `where`. See {@link useToolCallsPage}. */
export function useThreadsPage(page: number, pageSize: number, where: ThreadWhere) {
  return useQuery({
    queryKey: ['threads-page', page, pageSize, where],
    queryFn: () => agentClient.threadsPage({ page, pageSize, where }),
    placeholderData: keepPreviousData,
  });
}

/** Poll the cross-thread approvals inbox (tool calls sitting `pending_approval`). */
export function useApprovals(limit = 50) {
  return useQuery({
    queryKey: ['approvals', limit],
    queryFn: () => agentClient.approvals(limit),
  });
}

/** Decide a pending HITL tool call, refetching the approvals inbox on success. */
export function useDecideApproval() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ toolCallId, input }: { toolCallId: string; input: ApprovalDecisionInput }) =>
      agentClient.decideApproval(toolCallId, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['approvals'] });
    },
  });
}

/** Poll the per-tool call/failure/rejection/latency rollup for a range. */
export function useToolStats(range: GovernanceRange) {
  return useQuery({
    queryKey: ['tool-stats', range.fromDay, range.toDay],
    queryFn: () => agentClient.toolStats(range),
  });
}

/** Poll the current-prices list (the pricing tab). 501s when the host has no pricing store bound. */
export function usePricing() {
  return useQuery({
    queryKey: ['pricing'],
    queryFn: () => agentClient.pricing(),
  });
}

/** Upsert a model's current price, refetching the pricing list on success. */
export function useUpsertPrice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpsertModelPriceInput) => agentClient.upsertPrice(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pricing'] });
    },
  });
}
