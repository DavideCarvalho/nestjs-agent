import type { ReactNode } from 'react';
import type { ThreadDetail } from '../client/agent-client';
import { formatCount, formatDurationMs, formatUsd } from '../client/format-usd';
import { AlertIcon } from './icons';
import { Empty, Panel, Stat, StatusPill, relTime } from './ui';

/**
 * A thread drill-down: the lifetime token/cost rollup, the newest runs, and the newest messages.
 *
 * The usage rollup is LIFETIME, not range-scoped — deliberately, and labelled as such: a thread is
 * a conversation, and "what did this conversation cost" is not a question about the day range the
 * header happens to be showing.
 */
export function ThreadDetailPanel({
  detail,
  onOpenRun,
  runsHref,
}: {
  detail: ThreadDetail;
  onOpenRun?: (runId: string) => void;
  /** Deep link to the Reliability table filtered to this thread — see `hashForSection`. */
  runsHref?: string;
}) {
  const { thread, deleted, usage, runs, runTotal, messages } = detail;
  const runsHidden = runTotal - runs.length;
  const messagesHidden = thread.messageCount - messages.length;

  return (
    <div className="flex flex-col gap-4">
      {deleted && (
        <div className="panel flex items-center gap-2 border-[var(--warn)]/40 p-3 text-xs text-[var(--warn)]">
          <AlertIcon />
          <span>
            This thread is soft-deleted. Its history is still readable here — the thread is not.
          </span>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat
          label="Lifetime cost"
          value={formatUsd(usage.costUsd)}
          sub={`${usage.requests} req`}
        />
        <Stat
          label="Lifetime tokens"
          value={formatCount(usage.totalTokens)}
          sub={`${formatCount(usage.inputTokens)} in · ${formatCount(usage.outputTokens)} out`}
        />
        <Stat label="Runs" value={`${runTotal}`} sub="on this thread" />
        <Stat label="Messages" value={`${thread.messageCount}`} sub="on this thread" />
      </div>

      <Panel
        title="Runs"
        subtitle="Newest first"
        right={
          runsHidden > 0 &&
          runsHref !== undefined && (
            <a
              href={runsHref}
              className="rounded-md border border-[var(--line)] px-2 py-1 text-[10px] text-[var(--muted)] transition-colors hover:border-[var(--accent)]/50 hover:text-[var(--text)]"
            >
              Show all {runTotal} runs
            </a>
          )
        }
      >
        {runs.length === 0 ? (
          <Empty label="No runs on this thread" />
        ) : (
          <>
            <ul className="space-y-1">
              {runs.map((run) => (
                <li key={run.runId}>
                  <RowButton
                    onClick={onOpenRun === undefined ? undefined : () => onOpenRun(run.runId)}
                  >
                    <StatusPill status={run.status} />
                    <span className="mono truncate text-[var(--muted)]">
                      {run.agentName ?? '(default)'}
                    </span>
                    {run.errorCode !== null && (
                      <span className="mono truncate text-[10px] text-[var(--bad)]">
                        {run.errorCode}
                      </span>
                    )}
                    <span className="mono tnum ml-auto shrink-0 text-[10px] text-[var(--muted)]">
                      {formatDurationMs(run.durationMs)} · {relTime(run.startedAt)}
                    </span>
                  </RowButton>
                </li>
              ))}
            </ul>
            {runsHidden > 0 && (
              <p className="mono mt-2 text-[10px] text-[var(--muted)]">
                showing {runs.length} of {runTotal} — {runsHidden} older not loaded
              </p>
            )}
          </>
        )}
      </Panel>

      <Panel title="Messages" subtitle="Newest first, content capped server-side">
        {messages.length === 0 ? (
          <Empty label="No messages on this thread" />
        ) : (
          <>
            <ul className="space-y-2">
              {messages.map((message) => (
                <li
                  key={message.messageId}
                  className="rounded-md border border-[var(--line-soft)] px-2.5 py-2 text-xs"
                >
                  <div className="mono flex flex-wrap items-center gap-2 text-[10px] text-[var(--muted)]">
                    <span className="uppercase tracking-wider text-[var(--accent)]">
                      {message.role}
                    </span>
                    {message.agentName !== null && <span>· {message.agentName}</span>}
                    {message.toolCallCount > 0 && (
                      <span>
                        · {message.toolCallCount} tool call{message.toolCallCount === 1 ? '' : 's'}
                      </span>
                    )}
                    <span className="ml-auto">{relTime(message.createdAt)}</span>
                  </div>
                  <p className="mt-1 whitespace-pre-wrap break-words text-[var(--text)]">
                    {message.content}
                    {/* An explicit marker, never an implied tail: the server cut this, and a reader
                        who does not know that will quote a sentence that does not end there. */}
                    {message.truncated && (
                      <span className="mono text-[var(--muted)]"> […truncated]</span>
                    )}
                  </p>
                </li>
              ))}
            </ul>
            {messagesHidden > 0 && (
              <p className="mono mt-2 text-[10px] text-[var(--muted)]">
                showing {messages.length} of {thread.messageCount}
              </p>
            )}
          </>
        )}
      </Panel>
    </div>
  );
}

/** A table row that is a button when there is somewhere to go, and plain markup when there is not. */
function RowButton({
  onClick,
  children,
}: {
  onClick?: (() => void) | undefined;
  children: ReactNode;
}) {
  const className = 'flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left text-xs';
  if (onClick === undefined) {
    return <div className={className}>{children}</div>;
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className={`${className} transition-colors hover:bg-[var(--panel-2)]`}
    >
      {children}
    </button>
  );
}
