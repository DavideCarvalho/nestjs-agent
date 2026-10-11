import { useMemo, useState } from 'react';
import type { GenuiErrorRow, GenuiStats, UsageTrendPoint } from '../client/agent-client';
import { formatModelLabel } from '../client/format-model';
import { formatCount, formatDurationMs, formatPercent, formatUsd } from '../client/format-usd';
import type { TrendMetric } from '../client/trend-summary';
import { TrendChart } from './TrendChart';
import {
  ActivityIcon,
  AlertIcon,
  CheckIcon,
  ClockIcon,
  DollarIcon,
  LayoutIcon,
  RetryIcon,
  TrendIcon,
  XIcon,
} from './icons';
import { Badge, type BadgeProps } from './ui/badge';
import { Empty, Panel, Stat, relTime } from './ui/kit';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeadRow,
  TableHeader,
  TableRow,
} from './ui/table';
import { Tabs, TabsList, TabsTrigger } from './ui/tabs';
import { Tooltip } from './ui/tooltip';

/** A cost the store may not know (no price for the model): `—` rather than a misleading `$0.00`. */
function usdOrDash(amount: number | null): string {
  return amount === null ? '—' : formatUsd(amount);
}

/** A rate with no denominator (no first attempts) reads `—`, not `0%`. */
function rateOrDash(ratio: number | null): string {
  return ratio === null ? '—' : formatPercent(ratio);
}

/** Green when nearly every first attempt renders, amber when a sizeable share needs a retry. */
function rateTone(ratio: number | null): 'good' | 'warn' | 'bad' | undefined {
  if (ratio === null) return undefined;
  if (ratio >= 0.9) return 'good';
  if (ratio >= 0.7) return 'warn';
  return 'bad';
}

/** Literal class names (Tailwind only emits classes it can see spelled out in the source). */
const TONE_CLASS = { good: 'text-good', warn: 'text-warn', bad: 'text-bad' } as const;

/**
 * What an error category says about the fix. `unavailable` is a capability gap (the tool is not on
 * this channel), not a model mistake, so it reads as a warning; `other` is unclassified.
 */
function categoryVariant(category: string): BadgeProps['variant'] {
  if (category === 'unavailable') return 'warn';
  if (category === 'other') return 'outline';
  return 'bad';
}

/**
 * Generative UI. How well the model writes UI on its first try, per UI tool and model; which
 * mistakes it keeps making; what the UI calls cost; and how long a user waits for the first and the
 * finished frame.
 *
 * `unavailable` is the store that does not implement `genuiStats` (the API `501`s) — a posture,
 * rendered as its own explanatory state rather than an empty page that would read as "no UI calls".
 */
export function GenuiSection({
  stats,
  unavailable = false,
}: {
  stats: GenuiStats | null;
  unavailable?: boolean;
}) {
  if (unavailable || stats === null) {
    return (
      <Panel
        title="Generative UI"
        subtitle="First-try success, errors, cost and latency of UI tool calls"
      >
        <div className="rounded-lg border border-dashed border-line p-6 text-xs text-muted-foreground">
          This store does not record generative-UI telemetry — the bound `AGENT_GOVERNANCE_QUERIES`
          does not implement `genuiStats`. Use a store adapter that records UI tool calls
          (`recordGenuiCalls`) to enable this page.
        </div>
      </Panel>
    );
  }

  if (stats.totals.calls === 0) {
    return (
      <Panel
        title="Generative UI"
        subtitle="First-try success, errors, cost and latency of UI tool calls"
      >
        <Empty label="No generative-UI calls in this range" />
      </Panel>
    );
  }

  return <GenuiOverview stats={stats} />;
}

function GenuiOverview({ stats }: { stats: GenuiStats }) {
  const { totals, costPerTurn, latency } = stats;
  const firstTryTone = rateTone(totals.firstTryRate);
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
        <Stat
          label="UI calls"
          value={formatCount(totals.calls)}
          sub={`${formatCount(totals.inputTokens)} in · ${formatCount(totals.outputTokens)} out`}
          icon={<LayoutIcon />}
          tone="accent"
        />
        <Stat
          label="Turns"
          value={formatCount(totals.turns)}
          sub="with a UI call"
          icon={<ActivityIcon />}
        />
        <Stat
          label="First-try success"
          value={rateOrDash(totals.firstTryRate)}
          sub={`${totals.firstTrySuccesses} of ${totals.firstAttempts} first attempts`}
          icon={<CheckIcon />}
          {...(firstTryTone !== undefined ? { tone: firstTryTone } : {})}
        />
        <Stat
          label="Retried"
          value={formatCount(totals.retried)}
          sub="accepted after a refusal"
          icon={<RetryIcon />}
          {...(totals.retried > 0 ? { tone: 'warn' as const } : {})}
        />
        <Stat
          label="Failed"
          value={formatCount(totals.failed)}
          sub="refused calls"
          icon={<XIcon />}
          {...(totals.failed > 0 ? { tone: 'bad' as const } : {})}
        />
      </div>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat
          label="UI cost"
          value={usdOrDash(totals.costUsd)}
          sub="total over the range"
          icon={<DollarIcon />}
        />
        <Stat
          label="Cost / turn"
          value={usdOrDash(costPerTurn.avgUsd)}
          sub={`avg · p50 ${usdOrDash(costPerTurn.p50Usd)} · p95 ${usdOrDash(costPerTurn.p95Usd)}`}
          icon={<TrendIcon />}
        />
        <Stat
          label="Time to first frame"
          value={formatDurationMs(latency.firstFrame.p50Ms)}
          sub={`p50 · p95 ${formatDurationMs(latency.firstFrame.p95Ms)} · ${latency.firstFrame.samples} turns`}
          icon={<ClockIcon />}
        />
        <Stat
          label="Time to complete"
          value={formatDurationMs(latency.complete.p50Ms)}
          sub={`p50 · p95 ${formatDurationMs(latency.complete.p95Ms)} · ${latency.complete.samples} turns`}
          icon={<ClockIcon />}
        />
      </div>

      <ToolModelTable rows={stats.byToolModel} />
      <ErrorsTable rows={stats.errors} />
      <CostPerDay stats={stats} />
    </div>
  );
}

function ToolModelTable({ rows }: { rows: GenuiStats['byToolModel'] }) {
  return (
    <Panel
      title="First-try success by tool and model"
      subtitle="How often a turn's first UI attempt was accepted, per UI tool and model"
    >
      {rows.length === 0 ? (
        <Empty label="No UI tool calls in this range" />
      ) : (
        <Table className="min-w-[860px]">
          <TableHeader>
            <TableHeadRow>
              <TableHead>Tool</TableHead>
              <TableHead>Model</TableHead>
              <TableHead>Mode</TableHead>
              <TableHead className="text-right">Calls</TableHead>
              <TableHead className="text-right">First attempts</TableHead>
              <TableHead className="text-right">First-try rate</TableHead>
              <TableHead className="text-right">Retried</TableHead>
              <TableHead className="text-right">Failed</TableHead>
              <TableHead className="pl-4 text-right">Cost</TableHead>
            </TableHeadRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => {
              const tone = rateTone(row.firstTryRate);
              return (
                <TableRow key={`${row.toolName}\u0000${row.modelId}`}>
                  <TableCell className="pr-4">
                    <Tooltip label={row.toolName}>
                      <span className="block max-w-[200px] truncate text-foreground">
                        {row.toolName}
                      </span>
                    </Tooltip>
                  </TableCell>
                  <TableCell className="pr-4">
                    <Tooltip label={row.modelId}>
                      <span className="block max-w-[200px] truncate">
                        {formatModelLabel(row.modelId)}
                      </span>
                    </Tooltip>
                  </TableCell>
                  <TableCell className="pr-4">
                    <Badge>{row.mode}</Badge>
                  </TableCell>
                  <TableCell className="text-right">{row.calls}</TableCell>
                  <TableCell className="text-right">{row.firstAttempts}</TableCell>
                  <TableCell className={`text-right ${tone === undefined ? '' : TONE_CLASS[tone]}`}>
                    {rateOrDash(row.firstTryRate)}
                  </TableCell>
                  <TableCell className={`text-right ${row.retried > 0 ? 'text-warn' : ''}`}>
                    {row.retried}
                  </TableCell>
                  <TableCell className={`text-right ${row.failed > 0 ? 'text-bad' : ''}`}>
                    {row.failed}
                  </TableCell>
                  <TableCell className="pl-4 text-right text-foreground">
                    {usdOrDash(row.costUsd)}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </Panel>
  );
}

function ErrorsTable({ rows }: { rows: GenuiErrorRow[] }) {
  return (
    <Panel
      title="Common errors"
      subtitle="Why UI calls were refused, most frequent first (messages are scrubbed of values)"
      right={<AlertIcon className="text-muted-foreground" />}
    >
      {rows.length === 0 ? (
        <Empty label="No UI errors in this range" />
      ) : (
        <Table className="min-w-[760px]">
          <TableHeader>
            <TableHeadRow>
              <TableHead>Category</TableHead>
              <TableHead>Tool</TableHead>
              <TableHead>Message</TableHead>
              <TableHead className="text-right">Count</TableHead>
              <TableHead className="pl-4 text-right">Last seen</TableHead>
            </TableHeadRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={`${row.category}\u0000${row.toolName}\u0000${row.message}`}>
                <TableCell className="pr-4">
                  <Badge variant={categoryVariant(row.category)}>{row.category}</Badge>
                </TableCell>
                <TableCell className="pr-4 text-foreground">{row.toolName}</TableCell>
                <TableCell className="pr-4">
                  <Tooltip label={row.message}>
                    <span className="mono block max-w-[420px] truncate">
                      {row.message === '' ? '—' : row.message}
                    </span>
                  </Tooltip>
                </TableCell>
                <TableCell className="text-right text-foreground">{row.count}</TableCell>
                <TableCell className="pl-4 text-right">
                  <Tooltip label={row.lastAt}>
                    <span>{relTime(row.lastAt)}</span>
                  </Tooltip>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Panel>
  );
}

/** UI cost (or tokens) per day, drawn with the same trend chart the Spend section uses. */
function CostPerDay({ stats }: { stats: GenuiStats }) {
  const [metric, setMetric] = useState<TrendMetric>('costUsd');
  const points = useMemo<UsageTrendPoint[]>(
    () =>
      stats.byDay.map((day) => ({
        day: day.day,
        totalTokens: day.inputTokens + day.outputTokens,
        costUsd: day.costUsd ?? 0,
      })),
    [stats.byDay],
  );
  return (
    <Panel
      title="UI cost per day"
      subtitle="Per-day cost / tokens of UI tool calls across the range"
      right={
        <Tabs
          value={metric}
          onValueChange={(value) => setMetric(value as TrendMetric)}
          aria-label="UI trend metric"
        >
          <TabsList>
            <TabsTrigger value="costUsd">Cost</TabsTrigger>
            <TabsTrigger value="totalTokens">Tokens</TabsTrigger>
          </TabsList>
        </Tabs>
      }
    >
      {points.length === 0 ? (
        <Empty label="No UI calls recorded in this range" />
      ) : (
        <TrendChart points={points} metric={metric} />
      )}
    </Panel>
  );
}
