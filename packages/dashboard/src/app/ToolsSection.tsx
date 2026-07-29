import type { ToolStatRow } from '../client/agent-client';
import { formatDurationMs, formatPercent } from '../client/format-usd';
import { Badge } from './ui/badge';
import { Empty, Panel } from './ui/kit';
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
        <Table className="min-w-[700px]">
          <TableHeader>
            <TableHeadRow>
              <TableHead>Tool</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead className="text-right">Calls</TableHead>
              <TableHead className="text-right">Failure rate</TableHead>
              <TableHead className="text-right">Rejected</TableHead>
              <TableHead className="pl-4 text-right">p50 exec</TableHead>
              <TableHead className="pl-4 text-right">p95 exec</TableHead>
            </TableHeadRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => {
              const failureRate = row.calls > 0 ? row.failed / row.calls : 0;
              return (
                <TableRow key={row.toolName}>
                  <TableCell className="pr-4">
                    <Tooltip label={row.toolName}>
                      <span className="block max-w-[240px] truncate text-foreground">
                        {row.toolName}
                      </span>
                    </Tooltip>
                  </TableCell>
                  <TableCell className="pr-4">
                    <Badge>{row.toolType}</Badge>
                  </TableCell>
                  <TableCell className="text-right">{row.calls}</TableCell>
                  <TableCell className={`text-right ${row.failed > 0 ? 'text-bad' : ''}`}>
                    {formatPercent(failureRate)}
                  </TableCell>
                  <TableCell className="text-right">{row.rejected}</TableCell>
                  <TableCell className="pl-4 text-right text-foreground">
                    {formatDurationMs(row.p50ExecutionMs)}
                  </TableCell>
                  <TableCell className="pl-4 text-right">
                    {formatDurationMs(row.p95ExecutionMs)}
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
