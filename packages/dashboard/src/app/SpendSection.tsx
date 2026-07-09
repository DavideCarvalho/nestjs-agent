import { useState } from 'react';
import type { SpendOverview, ThreadSpendRow } from '../client/agent-client';
import { formatCount, formatUsd } from '../client/format-usd';
import { donutSegments, summarizeSpend, withShares } from '../client/spend-summary';
import type { TrendMetric } from '../client/trend-path';
import { Donut, colorAt } from './Donut';
import { TopThreadsSection } from './TopThreadsSection';
import { TrendChart } from './TrendChart';
import { ActivityIcon, ChipIcon, DollarIcon, TrendIcon } from './icons';
import { Empty, Panel, Stat } from './ui';

/** The headline governance section: total spend + usage, the by-model donut, and the daily trend. */
export function SpendSection({
  overview,
  topThreads,
}: {
  overview: SpendOverview;
  topThreads: ThreadSpendRow[];
}) {
  const [metric, setMetric] = useState<TrendMetric>('costUsd');
  const totals = summarizeSpend(overview.byModel);
  const shares = withShares(overview.byModel);
  const segments = donutSegments(shares);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat
          label="Total spend"
          value={formatUsd(totals.costUsd)}
          sub={`${totals.requests} requests`}
          icon={<DollarIcon />}
          tone="accent"
        />
        <Stat
          label="Total tokens"
          value={formatCount(totals.totalTokens)}
          sub={`${formatCount(totals.inputTokens)} in · ${formatCount(totals.outputTokens)} out`}
          icon={<ActivityIcon />}
        />
        <Stat
          label="Models used"
          value={`${overview.byModel.length}`}
          sub="distinct model ids"
          icon={<ChipIcon />}
        />
        <Stat
          label="Avg cost / request"
          value={formatUsd(totals.requests > 0 ? totals.costUsd / totals.requests : 0)}
          sub="over the range"
          icon={<TrendIcon />}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Panel title="Spend by model" subtitle="Share of cost across the range">
          {segments.length === 0 ? (
            <Empty label="No spend recorded in this range" />
          ) : (
            <div className="flex flex-col items-center gap-4 sm:flex-row">
              <Donut
                segments={segments}
                centerLabel={formatUsd(totals.costUsd)}
                centerSub="total"
              />
              <ul className="flex-1 space-y-1.5">
                {shares.slice(0, 8).map((row, index) => (
                  <li key={row.modelId} className="flex items-center gap-2 text-xs">
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-sm"
                      style={{ background: colorAt(index) }}
                    />
                    <span className="mono truncate text-[var(--text)]">{row.modelId}</span>
                    <span className="mono tnum ml-auto text-[var(--muted)]">
                      {formatUsd(row.costUsd)}
                    </span>
                    <span className="mono tnum w-9 text-right text-[var(--muted)]">
                      {Math.round(row.costShare * 100)}%
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Panel>

        <Panel
          className="lg:col-span-2"
          title="Daily usage trend"
          subtitle="Per-day spend / tokens across the range"
          right={
            <div className="flex gap-1">
              {(['costUsd', 'totalTokens'] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setMetric(option)}
                  className={`rounded-md border px-2 py-1 text-[11px] transition-colors ${
                    metric === option
                      ? 'border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--text)]'
                      : 'border-transparent text-[var(--muted)] hover:text-[var(--text)]'
                  }`}
                >
                  {option === 'costUsd' ? 'Cost' : 'Tokens'}
                </button>
              ))}
            </div>
          }
        >
          {overview.trend.length === 0 ? (
            <Empty label="No usage recorded in this range" />
          ) : (
            <TrendChart points={overview.trend} metric={metric} />
          )}
        </Panel>
      </div>

      <TopThreadsSection rows={topThreads} />
    </div>
  );
}
