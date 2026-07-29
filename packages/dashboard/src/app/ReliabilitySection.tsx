import type {
  GovernancePage,
  RecentRunRow,
  ReliabilityOverview,
  RunWhere,
} from '../client/agent-client';
import { errorSegments } from '../client/error-breakdown';
import { formatDurationMs, formatPercent } from '../client/format-usd';
import { Donut, colorAt } from './Donut';
import { RunTrendChart } from './RunTrendChart';
import { ActivityIcon, AlertIcon, ClockIcon, RetryIcon } from './icons';
import { Empty, FilterInput, Pagination, Panel, Stat, StatusPill, relTime } from './ui';

/** Run success rate, failure breakdown, run/failure trend and a paged, filterable recent-runs table. */
export function ReliabilitySection({
  overview,
  runsPage,
  runsWhere,
  onRunsStatusChange,
  onRunsAgentNameChange,
  onRunsPageChange,
}: {
  overview: ReliabilityOverview;
  runsPage: GovernancePage<RecentRunRow>;
  runsWhere: RunWhere;
  onRunsStatusChange: (value: string) => void;
  onRunsAgentNameChange: (value: string) => void;
  onRunsPageChange: (page: number) => void;
}) {
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
                    <span className="mono min-w-0 flex-1 truncate text-[var(--text)]">
                      {row.errorCode}
                    </span>
                    <span className="mono tnum ml-auto shrink-0 text-[var(--muted)]">
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
                  className="flex items-center gap-3 rounded-md px-2 py-1.5 text-xs hover:bg-[var(--panel-2)]"
                >
                  <span className="mono truncate text-[var(--text)]">{row.agentName}</span>
                  <span className="mono tnum ml-auto shrink-0 text-[10px] text-[var(--muted)]">
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
              <FilterInput
                value={runsWhere.status ?? ''}
                placeholder="status"
                onChange={onRunsStatusChange}
              />
              <FilterInput
                value={runsWhere.agentName ?? ''}
                placeholder="agent"
                onChange={onRunsAgentNameChange}
              />
            </div>
          }
        >
          {runsPage.rows.length === 0 ? (
            <Empty label="No runs yet" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] text-left text-xs">
                <thead className="text-[10px] uppercase tracking-wider text-[var(--muted)]">
                  <tr className="border-b border-[var(--line)]">
                    <th className="py-2 font-medium">Status</th>
                    <th className="py-2 font-medium">Agent</th>
                    <th className="py-2 text-right font-medium">Duration</th>
                    <th className="py-2 pl-4 font-medium">Error</th>
                    <th className="py-2 pl-4 font-medium">Prompt</th>
                    <th className="py-2 pl-4 text-right font-medium">Started</th>
                  </tr>
                </thead>
                <tbody className="mono tnum">
                  {runsPage.rows.map((run) => (
                    <tr key={run.runId} className="border-b border-[var(--line-soft)]">
                      <td className="py-2.5 pr-4">
                        <StatusPill status={run.status} />
                      </td>
                      <td className="py-2.5 pr-4 text-[var(--muted)]">
                        {run.agentName ?? '(default)'}
                      </td>
                      <td className="py-2.5 text-right text-[var(--muted)]">
                        {formatDurationMs(run.durationMs)}
                      </td>
                      <td className="py-2.5 pl-4">
                        {run.errorMessage ? (
                          <span
                            className="block max-w-[220px] truncate text-[var(--bad)]"
                            title={run.errorMessage}
                          >
                            {run.errorCode
                              ? `${run.errorCode}: ${run.errorMessage}`
                              : run.errorMessage}
                          </span>
                        ) : (
                          <span className="text-[var(--muted)]">—</span>
                        )}
                      </td>
                      <td className="py-2.5 pl-4">
                        {run.promptHash ? (
                          <span
                            title={run.promptHash}
                            className="mono rounded border border-[var(--line)] px-1 text-[10px] text-[var(--muted)]"
                          >
                            {run.promptHash.slice(0, 8)}
                          </span>
                        ) : (
                          <span className="text-[var(--muted)]">—</span>
                        )}
                      </td>
                      <td className="py-2.5 pl-4 text-right text-[10px] text-[var(--muted)]">
                        {relTime(run.startedAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <Pagination
                page={runsPage.page}
                pageSize={runsPage.pageSize}
                total={runsPage.total}
                onPage={onRunsPageChange}
              />
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
