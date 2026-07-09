import type { ThreadSpendRow } from '../client/agent-client';
import { formatCount, formatUsd } from '../client/format-usd';
import { Empty, Panel } from './ui';

/** Top threads by cost over the range: thread, actor, requests, tokens, and cost. */
export function TopThreadsSection({ rows }: { rows: ThreadSpendRow[] }) {
  return (
    <Panel title="Top threads by cost" subtitle="Highest-spend conversations over the range">
      {rows.length === 0 ? (
        <Empty label="No thread spend in this range" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-xs">
            <thead className="text-[10px] uppercase tracking-wider text-[var(--muted)]">
              <tr className="border-b border-[var(--line)]">
                <th className="py-2 font-medium">Thread</th>
                <th className="py-2 font-medium">Actor</th>
                <th className="py-2 text-right font-medium">Requests</th>
                <th className="py-2 text-right font-medium">Tokens</th>
                <th className="py-2 text-right font-medium">Cost</th>
              </tr>
            </thead>
            <tbody className="mono tnum">
              {rows.map((row) => (
                <tr key={row.threadId} className="border-b border-[var(--line-soft)]">
                  <td className="py-2.5">
                    <span className="truncate text-[var(--text)]">{row.title || row.threadId}</span>
                  </td>
                  <td className="py-2.5 truncate text-[var(--muted)]">{row.actorRef}</td>
                  <td className="py-2.5 text-right text-[var(--muted)]">{row.requests}</td>
                  <td className="py-2.5 text-right text-[var(--muted)]">
                    {formatCount(row.totalTokens)}
                  </td>
                  <td className="py-2.5 text-right text-[var(--text)]">{formatUsd(row.costUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
