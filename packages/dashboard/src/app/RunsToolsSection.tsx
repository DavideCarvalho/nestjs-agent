import type { ThreadActivityRow, ToolCallActivityRow } from '../client/agent-client';
import { formatCount } from '../client/format-usd';
import { AlertIcon } from './icons';
import { Empty, Panel, StatusPill, relTime } from './ui';

/** A tool call whose status reads as blocked/failed — surfaced as the "denied/forbidden" signal. */
function isDenied(status: string): boolean {
  return /forbidden|denied|error|failed|reject/i.test(status);
}

/** Recent tool calls + recent threads + a denied/forbidden banner drawn from the read-model. */
export function RunsToolsSection({
  toolCalls,
  threads,
}: {
  toolCalls: ToolCallActivityRow[];
  threads: ThreadActivityRow[];
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
        <Panel title="Recent tool calls" subtitle="Latest tool activity across threads">
          {toolCalls.length === 0 ? (
            <Empty label="No tool calls yet" />
          ) : (
            <ul className="space-y-1">
              {toolCalls.map((call) => (
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
          )}
        </Panel>

        <Panel title="Recent threads" subtitle="Latest conversations with rolled-up usage">
          {threads.length === 0 ? (
            <Empty label="No threads yet" />
          ) : (
            <ul className="space-y-1">
              {threads.map((thread) => (
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
          )}
        </Panel>
      </div>
    </div>
  );
}
