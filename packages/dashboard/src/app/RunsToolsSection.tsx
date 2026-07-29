import type {
  ThreadActivityRow,
  ThreadWhere,
  ToolCallActivityRow,
  ToolCallWhere,
} from '../client/agent-client';
import { formatCount } from '../client/format-usd';
import { InlineError } from './SectionBoundary';
import { AlertIcon } from './icons';
import type { PagedTable } from './paged-table';
import { Badge } from './ui/badge';
import { Card } from './ui/card';
import { Empty, FilterInput, OpenCell, Pagination, Panel, StatusPill, relTime } from './ui/kit';

/** A tool call whose status reads as blocked/failed — surfaced as the "denied/forbidden" signal. */
function isDenied(status: string): boolean {
  return /forbidden|denied|error|failed|reject/i.test(status);
}

/**
 * Recent tool calls (banner + a paged, filterable table) and a paged, filterable recent-threads
 * table, drawn from the read-model. Both tables open their row: a tool call leads to the run that
 * requested it, a thread to the conversation.
 */
export function RunsToolsSection({
  toolCalls,
  toolCallsTable,
  toolCallsWhere,
  onToolCallsToolNameChange,
  onToolCallsStatusChange,
  onToolCallsPageChange,
  threadsTable,
  threadsWhere,
  onThreadsTitleChange,
  onThreadsPageChange,
  onOpenRun,
  onOpenThread,
}: {
  /** Latest tool calls (unpaged, latest-N) — feeds the denied/forbidden banner. */
  toolCalls: ToolCallActivityRow[];
  toolCallsTable: PagedTable<ToolCallActivityRow>;
  toolCallsWhere: ToolCallWhere;
  onToolCallsToolNameChange: (value: string) => void;
  onToolCallsStatusChange: (value: string) => void;
  onToolCallsPageChange: (page: number) => void;
  threadsTable: PagedTable<ThreadActivityRow>;
  threadsWhere: ThreadWhere;
  onThreadsTitleChange: (value: string) => void;
  onThreadsPageChange: (page: number) => void;
  onOpenRun?: ((runId: string) => void) | undefined;
  onOpenThread?: ((threadId: string) => void) | undefined;
}) {
  const denied = toolCalls.filter((call) => isDenied(call.status));
  const toolCallsPage = toolCallsTable.page;
  const threadsPage = threadsTable.page;

  return (
    <div className="flex flex-col gap-4">
      {denied.length > 0 && (
        <Card className="flex items-center gap-2 border-bad/40 p-3 text-xs text-bad">
          <AlertIcon />
          <span className="mono">
            {denied.length} recent tool call{denied.length === 1 ? '' : 's'} blocked or failed
          </span>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel
          title="Recent tool calls"
          subtitle="Latest tool activity across threads"
          right={
            <div className="flex items-center gap-1.5">
              <FilterInput
                value={toolCallsWhere.toolName ?? ''}
                placeholder="tool name"
                onChange={onToolCallsToolNameChange}
              />
              <FilterInput
                value={toolCallsWhere.status ?? ''}
                placeholder="status"
                onChange={onToolCallsStatusChange}
              />
            </div>
          }
        >
          {toolCallsTable.error !== null && (
            <div className="mb-3">
              <InlineError
                label="Tool calls"
                error={toolCallsTable.error}
                onRetry={toolCallsTable.retry}
              />
            </div>
          )}
          {toolCallsPage.rows.length === 0 ? (
            <Empty label="No tool calls yet" />
          ) : (
            <>
              <ul className="space-y-1">
                {toolCallsPage.rows.map((call) => {
                  // Bound out of the row so the null check narrows inside the click handler; a
                  // pre-rollout call has no run and must render as text, not a dead button.
                  const runId = call.runId;
                  return (
                    <li
                      key={call.toolCallId}
                      className="flex items-center gap-3 rounded-md px-2 py-1.5 text-xs hover:bg-panel-2"
                    >
                      <StatusPill status={call.status} />
                      <span className="mono min-w-0">
                        <OpenCell
                          label={call.toolName}
                          title={runId ?? 'No run recorded for this call'}
                          onOpen={
                            onOpenRun === undefined || runId === null
                              ? undefined
                              : () => onOpenRun(runId)
                          }
                        />
                      </span>
                      <Badge>{call.toolType}</Badge>
                      <span className="mono ml-auto shrink-0 text-[10px] text-muted-foreground">
                        {relTime(call.createdAt)}
                      </span>
                    </li>
                  );
                })}
              </ul>
              <Pagination
                page={toolCallsPage.page}
                pageSize={toolCallsPage.pageSize}
                total={toolCallsPage.total}
                onPage={onToolCallsPageChange}
              />
            </>
          )}
        </Panel>

        <Panel
          title="Recent threads"
          subtitle="Latest conversations with rolled-up usage"
          right={
            <FilterInput
              value={threadsWhere.title ?? ''}
              placeholder="title"
              onChange={onThreadsTitleChange}
            />
          }
        >
          {threadsTable.error !== null && (
            <div className="mb-3">
              <InlineError
                label="Threads"
                error={threadsTable.error}
                onRetry={threadsTable.retry}
              />
            </div>
          )}
          {threadsPage.rows.length === 0 ? (
            <Empty label="No threads yet" />
          ) : (
            <>
              <ul className="space-y-1">
                {threadsPage.rows.map((thread) => (
                  <li
                    key={thread.threadId}
                    className="flex items-center gap-3 rounded-md px-2 py-1.5 text-xs hover:bg-panel-2"
                  >
                    <span className="min-w-0">
                      <OpenCell
                        label={thread.title || thread.threadId}
                        title={thread.threadId}
                        onOpen={
                          onOpenThread === undefined
                            ? undefined
                            : () => onOpenThread(thread.threadId)
                        }
                      />
                    </span>
                    <span className="mono ml-auto shrink-0 text-[10px] text-muted-foreground">
                      {thread.messageCount} msg · {formatCount(thread.totalTokens)} tok
                    </span>
                    <span className="mono shrink-0 text-[10px] text-muted-foreground">
                      {relTime(thread.lastActivityAt)}
                    </span>
                  </li>
                ))}
              </ul>
              <Pagination
                page={threadsPage.page}
                pageSize={threadsPage.pageSize}
                total={threadsPage.total}
                onPage={onThreadsPageChange}
              />
            </>
          )}
        </Panel>
      </div>
    </div>
  );
}
