import { useState } from 'react';
import type { FeatureSpendRow, SpendOverview, ThreadSpendRow } from '../client/agent-client';
import { formatModelLabel } from '../client/format-model';
import { formatCount, formatUsd } from '../client/format-usd';
import { donutSegments, summarizeSpend, withShares } from '../client/spend-summary';
import type { TrendMetric } from '../client/trend-summary';
import { Donut, colorAt } from './Donut';
import { TopThreadsSection } from './TopThreadsSection';
import { TrendChart } from './TrendChart';
import { ActivityIcon, ChipIcon, DollarIcon, TrendIcon } from './icons';
import { Empty, Panel, Stat } from './ui/kit';
import { Tabs, TabsList, TabsTrigger } from './ui/tabs';

/** The headline governance section: total spend + usage, the by-model donut, and the daily trend. */
export function SpendSection({
  overview,
  topThreads,
  onOpenThread,
}: {
  overview: SpendOverview;
  topThreads: ThreadSpendRow[];
  onOpenThread?: ((threadId: string) => void) | undefined;
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
                formatValue={formatUsd}
              />
              <ul className="flex-1 space-y-1.5">
                {shares.slice(0, 8).map((row, index) => (
                  <li key={row.modelId} className="flex items-center gap-2 text-xs">
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-sm"
                      style={{ background: colorAt(index) }}
                    />
                    <span
                      className="mono min-w-0 flex-1 truncate text-foreground"
                      title={row.modelId}
                    >
                      {formatModelLabel(row.modelId)}
                    </span>
                    <span className="mono tnum ml-auto shrink-0 text-muted-foreground">
                      {formatUsd(row.costUsd)}
                    </span>
                    <span className="mono tnum w-9 shrink-0 text-right text-muted-foreground">
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
            // A segmented control, so the two options are one roving tab stop with arrow-key
            // traversal rather than two separate buttons that merely look like a pair.
            <Tabs
              value={metric}
              onValueChange={(value) => setMetric(value as TrendMetric)}
              aria-label="Trend metric"
            >
              <TabsList>
                <TabsTrigger value="costUsd">Cost</TabsTrigger>
                <TabsTrigger value="totalTokens">Tokens</TabsTrigger>
              </TabsList>
            </Tabs>
          }
        >
          {overview.trend.length === 0 ? (
            <Empty label="No usage recorded in this range" />
          ) : (
            <TrendChart points={overview.trend} metric={metric} />
          )}
        </Panel>
      </div>

      {overview.byFeature !== undefined && (
        <Panel
          title="Spend by feature"
          subtitle="Agent turns and recorded usage (transcription, TTS, direct calls) side by side"
        >
          {overview.byFeature.length === 0 ? (
            <Empty label="No spend by feature in this range" />
          ) : (
            <FeatureTable rows={overview.byFeature} />
          )}
        </Panel>
      )}

      <TopThreadsSection rows={topThreads} onOpenThread={onOpenThread} />
    </div>
  );
}

/** What a feature row billed, in the units it billed by: tokens, audio, characters. */
export function featureUnits(row: FeatureSpendRow): string {
  const parts: string[] = [];
  const tokens = row.inputTokens + row.outputTokens;
  if (tokens > 0) parts.push(`${formatCount(tokens)} tok`);
  if (row.audioSeconds > 0) parts.push(`${formatCount(Math.round(row.audioSeconds))} s audio`);
  if (row.characters > 0) parts.push(`${formatCount(row.characters)} chars`);
  return parts.length > 0 ? parts.join(' · ') : '—';
}

function FeatureTable({ rows }: { rows: FeatureSpendRow[] }) {
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-left text-[10px] uppercase tracking-wider text-muted-foreground">
          <th className="py-1.5 font-medium">Feature</th>
          <th className="py-1.5 font-medium">Source</th>
          <th className="py-1.5 text-right font-medium">Requests</th>
          <th className="py-1.5 text-right font-medium">Units</th>
          <th className="py-1.5 text-right font-medium">Cost</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={`${row.source}:${row.feature}`} className="border-t border-line-soft">
            <td className="mono py-1.5 text-foreground">{row.feature}</td>
            <td className="py-1.5 text-muted-foreground">
              {row.source === 'agent' ? 'agent turn' : 'recorded'}
            </td>
            <td className="mono tnum py-1.5 text-right">{formatCount(row.requests)}</td>
            <td className="mono tnum py-1.5 text-right">{featureUnits(row)}</td>
            <td className="mono tnum py-1.5 text-right">{formatUsd(row.costUsd)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
