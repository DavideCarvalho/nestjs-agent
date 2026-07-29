import type { ToolStatRow } from '../client/agent-client';
import { formatDurationMs, formatPercent } from '../client/format-usd';
import { Empty, Panel } from './ui';

/**
 * Governance rollup per tool over a range: volume, failure/rejection rate, and BOTH latency
 * percentiles.
 *
 * p95 alone cannot tell a tool whose median is 100ms and whose tail is 10s from one that is
 * uniformly slow, and those are different problems with different fixes. Showing p50 next to it
 * costs one column and answers "is this tool slow, or does it occasionally hang?".
 */
export function ToolsSection({ rows }: { rows: ToolStatRow[] }) {
  return (
    <Panel
      title="Tools"
      subtitle="Per-tool call volume, failure/rejection rate and latency over the range"
    >
      {rows.length === 0 ? (
        <Empty label="No tool calls in this range" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[700px] text-left text-xs">
            <thead className="text-[10px] uppercase tracking-wider text-[var(--muted)]">
              <tr className="border-b border-[var(--line)]">
                <th className="py-2 font-medium">Tool</th>
                <th className="py-2 font-medium">Kind</th>
                <th className="py-2 text-right font-medium">Calls</th>
                <th className="py-2 text-right font-medium">Failure rate</th>
                <th className="py-2 text-right font-medium">Rejected</th>
                <th className="py-2 pl-4 text-right font-medium">p50 exec</th>
                <th className="py-2 pl-4 text-right font-medium">p95 exec</th>
              </tr>
            </thead>
            <tbody className="mono tnum">
              {rows.map((row) => {
                const failureRate = row.calls > 0 ? row.failed / row.calls : 0;
                return (
                  <tr key={row.toolName} className="border-b border-[var(--line-soft)]">
                    <td className="py-2.5 pr-4">
                      <span
                        className="block max-w-[240px] truncate text-[var(--text)]"
                        title={row.toolName}
                      >
                        {row.toolName}
                      </span>
                    </td>
                    <td className="py-2.5 pr-4">
                      <span className="rounded border border-[var(--line)] px-1 text-[10px] text-[var(--muted)]">
                        {row.toolType}
                      </span>
                    </td>
                    <td className="py-2.5 text-right text-[var(--muted)]">{row.calls}</td>
                    <td
                      className={`py-2.5 text-right ${row.failed > 0 ? 'text-[var(--bad)]' : 'text-[var(--muted)]'}`}
                    >
                      {formatPercent(failureRate)}
                    </td>
                    <td className="py-2.5 text-right text-[var(--muted)]">{row.rejected}</td>
                    <td className="py-2.5 pl-4 text-right text-[var(--text)]">
                      {formatDurationMs(row.p50ExecutionMs)}
                    </td>
                    <td className="py-2.5 pl-4 text-right text-[var(--muted)]">
                      {formatDurationMs(row.p95ExecutionMs)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
