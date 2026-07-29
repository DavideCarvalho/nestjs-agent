import type { ModelSpendRow } from '../client/agent-client';
import { formatModelLabel } from '../client/format-model';
import { formatCount, formatUsd } from '../client/format-usd';
import { withShares } from '../client/spend-summary';
import { colorAt } from './Donut';
import { BarMeter, Empty, Panel } from './ui/kit';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeadRow,
  TableHeader,
  TableRow,
} from './ui/table';
import { Tooltip } from './ui/tooltip';

/** Per-model breakdown: requests, in/out tokens, cost, and share-of-cost bar. */
export function ModelsSection({ rows }: { rows: ModelSpendRow[] }) {
  const shares = withShares(rows);

  return (
    <Panel title="Models" subtitle="Requests, tokens and cost per model over the range">
      {shares.length === 0 ? (
        <Empty label="No model usage in this range" />
      ) : (
        <Table className="min-w-[640px]">
          <TableHeader>
            <TableHeadRow>
              <TableHead>Model</TableHead>
              <TableHead className="text-right">Requests</TableHead>
              <TableHead className="text-right">Input</TableHead>
              <TableHead className="text-right">Output</TableHead>
              <TableHead className="text-right">Cost</TableHead>
              <TableHead className="pl-4">Share</TableHead>
            </TableHeadRow>
          </TableHeader>
          <TableBody>
            {shares.map((row, index) => (
              <TableRow key={row.modelId}>
                <TableCell className="pr-4">
                  <span className="flex items-center gap-2">
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-sm"
                      style={{ background: colorAt(index) }}
                    />
                    <Tooltip label={row.modelId}>
                      <span className="block max-w-[240px] truncate text-foreground">
                        {formatModelLabel(row.modelId)}
                      </span>
                    </Tooltip>
                  </span>
                </TableCell>
                <TableCell className="text-right">{row.requests}</TableCell>
                <TableCell className="text-right">{formatCount(row.inputTokens)}</TableCell>
                <TableCell className="text-right">{formatCount(row.outputTokens)}</TableCell>
                <TableCell className="text-right text-foreground">
                  {formatUsd(row.costUsd)}
                </TableCell>
                <TableCell className="pl-4">
                  <div className="flex items-center gap-2">
                    <BarMeter ratio={row.costShare} className="w-24" />
                    <span className="w-9 text-right">{Math.round(row.costShare * 100)}%</span>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Panel>
  );
}
