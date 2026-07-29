import type { RecentRunRow, ReliabilityOverview, RunWhere } from '../client/agent-client';
import { errorSegments } from '../client/error-breakdown';
import { formatDurationMs, formatPercent } from '../client/format-usd';
import { Donut, colorAt } from './Donut';
import { RunTrendChart } from './RunTrendChart';
import { InlineError } from './SectionBoundary';
import { ActivityIcon, AlertIcon, ClockIcon, RetryIcon, XIcon } from './icons';
import type { PagedTable } from './paged-table';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Empty, FilterInput, Pagination, Panel, Stat, StatusPill, relTime } from './ui/kit';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeadRow,
  TableHeader,
  TableRow,
} from './ui/table';

/**
 * A run's status is a CLOSED set — `governance-queries.ts` documents `RecentRunRow.status` as
 * 'running' | 'completed' | 'failed' — so the filter offers the three rather than asking an operator
 * to guess the spelling of a value they cannot see.
 *
 * Note the deliberate asymmetry with the tool-call status filter in `RunsToolsSection`, which stays
 * a free-text box: `ToolCallActivityRow.status` is typed as a bare `string` that a store may fill
 * however it likes, and a dropdown there would silently hide whatever it does not list.
 */
const RUN_STATUS_OPTIONS = [
  { value: '', label: 'any status' },
  { value: 'running', label: 'running' },
  { value: 'completed', label: 'completed' },
  { value: 'failed', label: 'failed' },
] as const;

/** Run success rate, failure breakdown, run/failure trend and a paged, filterable recent-runs table. */
export function ReliabilitySection({
  overview,
  runsTable,
  runsWhere,
  onRunsStatusChange,
  onRunsAgentNameChange,
  onRunsThreadIdClear,
  onRunsPageChange,
  onOpenRun,
}: {
  overview: ReliabilityOverview;
  runsTable: PagedTable<RecentRunRow>;
  runsWhere: RunWhere;
  onRunsStatusChange: (value: string) => void;
  onRunsAgentNameChange: (value: string) => void;
  /** Drops the `threadId` filter a thread drill-down deep-linked in. */
  onRunsThreadIdClear: () => void;
  onRunsPageChange: (page: number) => void;
  onOpenRun?: ((runId: string) => void) | undefined;
}) {
  const runsPage = runsTable.page;
  const { metrics, byAgent, errors, trend } = overview;
  const errorRate = metrics.runs > 0 ? metrics.failed / metrics.runs : 0;
  const segments = errorSegments(errors);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat
          label="Success rate"
          value={formatPercent(metrics.successRate)}
          sub={`${metrics.completed} / ${metrics.runs} runs`}
          icon={<ActivityIcon />}
          tone="good"
        />
        <Stat
          label="Error rate"
          value={formatPercent(errorRate)}
          sub={`${metrics.failed} failed`}
          icon={<AlertIcon />}
          {...(metrics.failed > 0 ? { tone: 'bad' as const } : {})}
        />
        <Stat
          label="Retries"
          value={`${metrics.retries}`}
          sub="LLM-step attempts > 1"
          icon={<RetryIcon />}
        />
        <Stat
          label="p95 duration"
          value={formatDurationMs(metrics.durationP95Ms)}
          sub={`p50 ${formatDurationMs(metrics.durationP50Ms)}`}
          icon={<ClockIcon />}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Panel title="Failures by error code" subtitle="Share of failed runs over the range">
          {segments.length === 0 ? (
            <Empty label="No failed runs in this range" />
          ) : (
            <div className="flex flex-col items-center gap-4 sm:flex-row">
              <Donut
                segments={segments}
                centerLabel={`${metrics.failed}`}
                centerSub="failed"
                label="failures by error code"
                formatValue={(value) => `${value} runs`}
              />
              <ul className="flex-1 space-y-1.5">
                {errors.map((row, index) => (
                  <li key={row.errorCode} className="flex items-center gap-2 text-xs">
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-sm"
                      style={{ background: colorAt(index) }}
                    />
                    <span className="mono min-w-0 flex-1 truncate text-foreground">
                      {row.errorCode}
                    </span>
                    <span className="mono tnum ml-auto shrink-0 text-muted-foreground">
                      {row.count}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Panel>

        <Panel
          className="lg:col-span-2"
          title="Run & failure trend"
          subtitle="Daily total runs vs. failed runs across the range"
        >
          {trend.length === 0 ? (
            <Empty label="No runs recorded in this range" />
          ) : (
            <RunTrendChart points={trend} />
          )}
        </Panel>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel title="Runs by agent" subtitle="Volume, failures and retries per agent">
          {byAgent.length === 0 ? (
            <Empty label="No runs in this range" />
          ) : (
            <ul className="space-y-1">
              {byAgent.map((row) => (
                <li
                  key={row.agentName}
                  className="flex items-center gap-3 rounded-md px-2 py-1.5 text-xs hover:bg-panel-2"
                >
                  <span className="mono truncate text-foreground">{row.agentName}</span>
                  <span className="mono tnum ml-auto shrink-0 text-[10px] text-muted-foreground">
                    {row.runs} runs · {row.failed} failed · {row.retries} retries
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel
          title="Recent runs"
          subtitle="Latest run outcomes across threads"
          right={
            <div className="flex items-center gap-1.5">
              <Select
                // `items` is not optional decoration: without it the trigger can only read a label
                // off a MOUNTED item, so a closed select renders blank on first paint.
                items={RUN_STATUS_OPTIONS}
                value={runsWhere.status ?? ''}
                onValueChange={(value) => onRunsStatusChange(String(value ?? ''))}
              >
                <SelectTrigger aria-label="Filter by run status" className="w-28">
                  {/* No placeholder: "any status" IS the empty value, so the trigger shows that
                      option's own label rather than a separate placeholder string. */}
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RUN_STATUS_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FilterInput
                value={runsWhere.agentName ?? ''}
                placeholder="agent"
                onChange={onRunsAgentNameChange}
              />
            </div>
          }
        >
          {/* A thread drill-down links in here with `?threadId=…`. Shown as a removable chip rather
              than a silent filter — a table quietly showing one thread's runs looks like an outage. */}
          {runsWhere.threadId !== undefined && (
            <Button variant="accent" size="xs" onClick={onRunsThreadIdClear} className="mono mb-3">
              thread {runsWhere.threadId}
              <XIcon />
            </Button>
          )}
          {runsTable.error !== null && (
            <div className="mb-3">
              <InlineError label="Runs" error={runsTable.error} onRetry={runsTable.retry} />
            </div>
          )}
          {runsPage.rows.length === 0 ? (
            <Empty label="No runs yet" />
          ) : (
            <>
              <Table className="min-w-[520px]">
                <TableHeader>
                  <TableHeadRow>
                    <TableHead>Status</TableHead>
                    <TableHead>Agent</TableHead>
                    <TableHead className="text-right">Duration</TableHead>
                    <TableHead className="pl-4">Error</TableHead>
                    <TableHead className="pl-4">Prompt</TableHead>
                    <TableHead className="pl-4 text-right">Started</TableHead>
                  </TableHeadRow>
                </TableHeader>
                <TableBody>
                  {runsPage.rows.map((run) => (
                    <TableRow key={run.runId} className="hover:bg-panel-2">
                      {/* The status pill is the row's handle: it is the first thing an operator
                          reads and the reason they want the run open. */}
                      <TableCell className="pr-4">
                        {onOpenRun === undefined ? (
                          <StatusPill status={run.status} />
                        ) : (
                          <button
                            type="button"
                            title={`Open run ${run.runId}`}
                            onClick={() => onOpenRun(run.runId)}
                            className="underline decoration-line decoration-dotted underline-offset-4 transition-colors hover:decoration-brand"
                          >
                            <StatusPill status={run.status} />
                          </button>
                        )}
                      </TableCell>
                      <TableCell className="pr-4">{run.agentName ?? '(default)'}</TableCell>
                      <TableCell className="text-right">
                        {formatDurationMs(run.durationMs)}
                      </TableCell>
                      <TableCell className="pl-4">
                        {run.errorMessage ? (
                          <span
                            className="block max-w-[220px] truncate text-bad"
                            title={run.errorMessage}
                          >
                            {run.errorCode
                              ? `${run.errorCode}: ${run.errorMessage}`
                              : run.errorMessage}
                          </span>
                        ) : (
                          '—'
                        )}
                      </TableCell>
                      <TableCell className="pl-4">
                        {run.promptHash ? (
                          <Badge title={run.promptHash}>{run.promptHash.slice(0, 8)}</Badge>
                        ) : (
                          '—'
                        )}
                      </TableCell>
                      <TableCell className="pl-4 text-right text-[10px]">
                        {relTime(run.startedAt)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <Pagination
                page={runsPage.page}
                pageSize={runsPage.pageSize}
                total={runsPage.total}
                onPage={onRunsPageChange}
              />
            </>
          )}
        </Panel>
      </div>
    </div>
  );
}
