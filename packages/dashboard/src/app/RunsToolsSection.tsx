import type {
  GovernancePage,
  ThreadActivityRow,
  ThreadWhere,
  ToolCallActivityRow,
  ToolCallWhere,
} from '../client/agent-client';
import { formatCount } from '../client/format-usd';
import { AlertIcon } from './icons';
import { Empty, FilterInput, Pagination, Panel, StatusPill, relTime } from './ui';

/** A tool call whose status reads as blocked/failed — surfaced as the "denied/forbidden" signal. */
function isDenied(status: string): boolean {
  return /forbidden|denied|error|failed|reject/i.test(status);
}

/**
 * Recent tool calls (banner + a paged, filterable table) and a paged, filterable recent-threads
 * table, drawn from the read-model.
 */
export function RunsToolsSection({
  toolCalls,
  toolCallsPage,
  toolCallsWhere,
  onToolCallsToolNameChange,
  onToolCallsStatusChange,
  onToolCallsPageChange,
  threadsPage,
  threadsWhere,
  onThreadsTitleChange,
  onThreadsPageChange,
}: {
  /** Latest tool calls (unpaged, latest-N) — feeds the denied/forbidden banner. */
  toolCalls: ToolCallActivityRow[];
  toolCallsPage: GovernancePage<ToolCallActivityRow>;
  toolCallsWhere: ToolCallWhere;
  onToolCallsToolNameChange: (value: string) => void;
  onToolCallsStatusChange: (value: string) => void;
  onToolCallsPageChange: (page: number) => void;
  threadsPage: GovernancePage<ThreadActivityRow>;
  threadsWhere: ThreadWhere;
  onThreadsTitleChange: (value: string) => void;
  onThreadsPageChange: (page: number) => void;
}) {
  const denied = toolCalls.filter((call) => isDenied(call.status));

  return (
    <div className="flex flex-col gap-4">
      {denied.length > 0 && (
        <div className="panel flex items-center gap-2 border-[var(--bad)]/40 p-3 text-xs text-[var(--bad)]">
          <AlertIcon />
          <span className="mono">
            {denied.length} recent tool call{denied.length === 1 ? '' : 's'} blocked or failed
          </span>
        </div>
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
          {toolCallsPage.rows.length === 0 ? (
            <Empty label="No tool calls yet" />
          ) : (
            <>
              <ul className="space-y-1">
                {toolCallsPage.rows.map((call) => (
                  <li
                    key={call.toolCallId}
                    className="flex items-center gap-3 rounded-md px-2 py-1.5 text-xs hover:bg-[var(--panel-2)]"
                  >
                    <StatusPill status={call.status} />
                    <span className="mono truncate text-[var(--text)]">{call.toolName}</span>
                    <span className="mono rounded border border-[var(--line)] px-1 text-[10px] text-[var(--muted)]">
                      {call.toolType}
                    </span>
                    <span className="mono ml-auto shrink-0 text-[10px] text-[var(--muted)]">
                      {relTime(call.createdAt)}
                    </span>
                  </li>
                ))}
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
          {threadsPage.rows.length === 0 ? (
            <Empty label="No threads yet" />
          ) : (
            <>
              <ul className="space-y-1">
                {threadsPage.rows.map((thread) => (
                  <li
                    key={thread.threadId}
                    className="flex items-center gap-3 rounded-md px-2 py-1.5 text-xs hover:bg-[var(--panel-2)]"
                  >
                    <span className="truncate text-[var(--text)]">
                      {thread.title || thread.threadId}
                    </span>
                    <span className="mono ml-auto shrink-0 text-[10px] text-[var(--muted)]">
                      {thread.messageCount} msg · {formatCount(thread.totalTokens)} tok
                    </span>
                    <span className="mono shrink-0 text-[10px] text-[var(--muted)]">
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
