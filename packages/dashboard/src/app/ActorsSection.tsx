import type { ActorSpendRow } from '../client/agent-client';
import { type BudgetMap, joinBudgets } from '../client/budget-usage';
import { formatCount, formatUsd } from '../client/format-usd';
import { BarMeter, Empty, Panel } from './ui';

/**
 * Spend by actor/tenant, with a usage-vs-budget bar shown only for actors whose daily token limit is
 * known (passed in `budgets`). Actors with no configured limit show their spend and a muted "no limit
 * set" hint — the read-model doesn't carry budgets, so the host supplies them when it has them.
 */
export function ActorsSection({
  rows,
  budgets = {},
}: {
  rows: ActorSpendRow[];
  budgets?: BudgetMap;
}) {
  const actors = joinBudgets(rows, budgets);

  return (
    <Panel
      title="Actors & budgets"
      subtitle="Spend per acting ref, with usage vs configured budget"
    >
      {actors.length === 0 ? (
        <Empty label="No actor activity in this range" />
      ) : (
        <ul className="space-y-2.5">
          {actors.map((actor) => (
            <li key={actor.actorRef} className="rounded-lg border border-[var(--line-soft)] p-3">
              <div className="flex items-center justify-between gap-3">
                <span className="flex min-w-0 items-baseline gap-2">
                  {actor.actorLabel ? (
                    <>
                      <span className="truncate text-xs text-[var(--text)]">
                        {actor.actorLabel}
                      </span>
                      <span className="mono truncate text-[10px] text-[var(--muted)]">
                        {actor.actorRef}
                      </span>
                    </>
                  ) : (
                    <span className="mono truncate text-xs text-[var(--text)]">
                      {actor.actorRef}
                    </span>
                  )}
                </span>
                <span className="mono tnum flex items-center gap-3 text-xs text-[var(--muted)]">
                  <span>{actor.requests} req</span>
                  <span>{formatCount(actor.totalTokens)} tok</span>
                  <span className="text-[var(--text)]">{formatUsd(actor.costUsd)}</span>
                </span>
              </div>
              {actor.usageRatio !== undefined && actor.limitTokens !== undefined ? (
                <div className="mt-2 flex items-center gap-2">
                  <BarMeter ratio={actor.usageRatio} over={actor.overBudget} className="flex-1" />
                  <span
                    className={`mono tnum text-[10px] ${
                      actor.overBudget ? 'text-[var(--bad)]' : 'text-[var(--muted)]'
                    }`}
                  >
                    {formatCount(actor.totalTokens)} / {formatCount(actor.limitTokens)}
                    {actor.overBudget ? ' · over' : ''}
                  </span>
                </div>
              ) : (
                <div className="mono mt-2 text-[10px] text-[var(--muted)]">no daily limit set</div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
