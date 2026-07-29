import type { ThreadSpendRow } from '../client/agent-client';
import { formatCount, formatUsd } from '../client/format-usd';
import { Empty, OpenCell, Panel } from './ui/kit';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeadRow,
  TableHeader,
  TableRow,
} from './ui/table';

/** Top threads by cost over the range: thread, actor, requests, tokens, and cost. */
export function TopThreadsSection({
  rows,
  onOpenThread,
}: {
  rows: ThreadSpendRow[];
  onOpenThread?: ((threadId: string) => void) | undefined;
}) {
  return (
    <Panel title="Top threads by cost" subtitle="Highest-spend conversations over the range">
      {rows.length === 0 ? (
        <Empty label="No thread spend in this range" />
      ) : (
        <Table className="min-w-[640px]">
          <TableHeader>
            <TableHeadRow>
              <TableHead>Thread</TableHead>
              <TableHead>Actor</TableHead>
              <TableHead className="text-right">Requests</TableHead>
              <TableHead className="text-right">Tokens</TableHead>
              <TableHead className="text-right">Cost</TableHead>
            </TableHeadRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.threadId}>
                <TableCell className="max-w-[260px]">
                  <OpenCell
                    label={row.title || row.threadId}
                    title={row.threadId}
                    onOpen={
                      onOpenThread === undefined ? undefined : () => onOpenThread(row.threadId)
                    }
                  />
                </TableCell>
                <TableCell className="truncate">{row.actorLabel ?? row.actorRef}</TableCell>
                <TableCell className="text-right">{row.requests}</TableCell>
                <TableCell className="text-right">{formatCount(row.totalTokens)}</TableCell>
                <TableCell className="text-right text-foreground">
                  {formatUsd(row.costUsd)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Panel>
  );
}
