import type { ActorSpendRow } from './agent-client';

/** A configured per-actor daily token budget, keyed by `actorRef`. Empty when no budgets are known. */
export type BudgetMap = Record<string, number>;

/** An actor's spend joined with its budget (when one is configured). */
export interface ActorBudget {
  actorRef: string;
  requests: number;
  totalTokens: number;
  costUsd: number;
  /** Human-readable label resolved from `actorRef`, when an `ActorDirectory` is bound server-side. */
  actorLabel: string | null;
  /** Configured daily token limit, when known. */
  limitTokens?: number;
  /** `totalTokens / limitTokens` (0..N; can exceed 1). Present only when a limit is known. */
  usageRatio?: number;
  /** True when a known limit is met or exceeded. */
  overBudget: boolean;
}

/**
 * Join by-actor spend with the configured daily budgets. An actor with no configured limit keeps its
 * spend but carries no `limitTokens`/`usageRatio` (the UI hides the bar — "usage vs limit when
 * known"). Sorted by cost descending. Pure.
 */
export function joinBudgets(rows: ActorSpendRow[], budgets: BudgetMap = {}): ActorBudget[] {
  return rows
    .map((row) => {
      const limit = budgets[row.actorRef];
      const hasLimit = typeof limit === 'number' && limit > 0;
      const usageRatio = hasLimit ? row.totalTokens / limit : undefined;
      return {
        actorRef: row.actorRef,
        requests: row.requests,
        totalTokens: row.totalTokens,
        costUsd: row.costUsd,
        actorLabel: row.actorLabel,
        overBudget: usageRatio !== undefined && usageRatio >= 1,
        ...(hasLimit ? { limitTokens: limit } : {}),
        ...(usageRatio !== undefined ? { usageRatio } : {}),
      };
    })
    .sort((a, b) => b.costUsd - a.costUsd || b.totalTokens - a.totalTokens);
}
