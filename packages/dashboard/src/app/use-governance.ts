import { useQuery } from '@tanstack/react-query';
import { type GovernanceRange, agentClient } from '../client/agent-client';

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
