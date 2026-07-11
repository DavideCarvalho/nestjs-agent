import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type GovernanceRange,
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

/** Poll the recent tool-calls feed. */
export function useToolCalls(limit = 50) {
  return useQuery({
    queryKey: ['tool-calls', limit],
    queryFn: () => agentClient.toolCalls(limit),
  });
}

/** Poll the recent threads feed. */
export function useThreads(limit = 50) {
  return useQuery({
    queryKey: ['threads', limit],
    queryFn: () => agentClient.threads(limit),
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
