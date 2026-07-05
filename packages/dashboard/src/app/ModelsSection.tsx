import type { ModelSpendRow } from '../client/agent-client';
import { formatCount, formatUsd } from '../client/format-usd';
import { withShares } from '../client/spend-summary';
import { colorAt } from './Donut';
import { BarMeter, Empty, Panel } from './ui';

/** Per-model breakdown: requests, in/out tokens, cost, and share-of-cost bar. */
export function ModelsSection({ rows }: { rows: ModelSpendRow[] }) {
  const shares = withShares(rows);

  return (
    <Panel title="Models" subtitle="Requests, tokens and cost per model over the range">
      {shares.length === 0 ? (
        <Empty label="No model usage in this range" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-xs">
            <thead className="text-[10px] uppercase tracking-wider text-[var(--muted)]">
              <tr className="border-b border-[var(--line)]">
                <th className="py-2 font-medium">Model</th>
                <th className="py-2 text-right font-medium">Requests</th>
                <th className="py-2 text-right font-medium">Input</th>
                <th className="py-2 text-right font-medium">Output</th>
                <th className="py-2 text-right font-medium">Cost</th>
                <th className="py-2 pl-4 font-medium">Share</th>
              </tr>
            </thead>
            <tbody className="mono tnum">
              {shares.map((row, index) => (
                <tr key={row.modelId} className="border-b border-[var(--line-soft)]">
                  <td className="py-2.5">
                    <span className="flex items-center gap-2">
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-sm"
                        style={{ background: colorAt(index) }}
                      />
                      <span className="truncate text-[var(--text)]">{row.modelId}</span>
                    </span>
                  </td>
                  <td className="py-2.5 text-right text-[var(--muted)]">{row.requests}</td>
                  <td className="py-2.5 text-right text-[var(--muted)]">
                    {formatCount(row.inputTokens)}
                  </td>
                  <td className="py-2.5 text-right text-[var(--muted)]">
                    {formatCount(row.outputTokens)}
                  </td>
                  <td className="py-2.5 text-right text-[var(--text)]">{formatUsd(row.costUsd)}</td>
                  <td className="py-2.5 pl-4">
                    <div className="flex items-center gap-2">
                      <BarMeter ratio={row.costShare} className="w-24" />
                      <span className="w-9 text-right text-[var(--muted)]">
                        {Math.round(row.costShare * 100)}%
                      </span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
