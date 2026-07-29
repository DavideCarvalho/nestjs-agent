import type { ReactNode } from 'react';
import type { RunDetail } from '../client/agent-client';
import { formatDurationMs } from '../client/format-usd';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Empty, Panel, StatusPill, relTime } from './ui/kit';

/**
 * A run drill-down: the run's outcome, the FULL error text a table row could only truncate, and the
 * tool calls it made in the order it requested them.
 *
 * There is no cost figure and that is not an omission to fix here — the token ledger has no run
 * column, so per-run spend is not attributable, and a plausible-looking number would be worse than
 * a missing one on a governance screen.
 */
export function RunDetailPanel({
  detail,
  onOpenThread,
}: {
  detail: RunDetail;
  onOpenThread?: (threadId: string) => void;
}) {
  const { run, thread, toolCalls } = detail;

  return (
    <div className="flex flex-col gap-4">
      <Panel title="Outcome">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-xs sm:grid-cols-3">
          <Field label="Status">
            <StatusPill status={run.status} />
          </Field>
          <Field label="Agent">{run.agentName ?? '(default)'}</Field>
          <Field label="Duration">{formatDurationMs(run.durationMs)}</Field>
          <Field label="Retries">{`${run.retries}`}</Field>
          <Field label="Started">{relTime(run.startedAt)}</Field>
          <Field label="Actor">{run.actorRef}</Field>
        </dl>

        {run.errorMessage !== null && (
          <div className="mt-3 rounded-lg border border-bad/40 bg-bad/5 p-3">
            {run.errorCode !== null && (
              <div className="mono text-[10px] uppercase tracking-wider text-bad">
                {run.errorCode}
              </div>
            )}
            {/* Wrapped, not truncated: the table row already truncated it, and opening the row is
                the whole reason an operator is here. */}
            <pre className="mono mt-1 whitespace-pre-wrap break-words text-[11px] text-foreground">
              {run.errorMessage}
            </pre>
          </div>
        )}

        {run.promptHash !== null && (
          <div className="mono mt-3 text-[10px] text-muted-foreground">
            prompt sha256 <span className="text-foreground">{run.promptHash}</span>
          </div>
        )}
      </Panel>

      <Panel
        title="Thread"
        subtitle="The conversation this run belongs to"
        right={
          onOpenThread && (
            <Button size="xs" onClick={() => onOpenThread(thread.threadId)}>
              Open thread
            </Button>
          )
        }
      >
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-foreground">{thread.title || thread.threadId}</span>
          <span className="mono text-[10px] text-muted-foreground">
            {thread.actorLabel ?? thread.actorRef}
          </span>
          {thread.deleted && <Badge variant="warn">deleted</Badge>}
        </div>
      </Panel>

      <Panel
        title="Tool calls"
        subtitle="Every call this run requested, oldest first"
        right={
          <span className="mono tnum text-[10px] text-muted-foreground">{toolCalls.length}</span>
        }
      >
        {toolCalls.length === 0 ? (
          // Two different truths, and the read-model cannot tell them apart: a run that called no
          // tools, and a run recorded before tool calls carried a run id. Say so rather than pick.
          <Empty label="No tool calls recorded for this run" />
        ) : (
          <ul className="space-y-1.5">
            {toolCalls.map((call) => (
              <li
                key={call.toolCallId}
                className="rounded-md border border-line-soft px-2.5 py-2 text-xs"
              >
                <div className="flex flex-wrap items-center gap-2.5">
                  <StatusPill status={call.status} />
                  <span className="mono truncate text-foreground">{call.toolName}</span>
                  <Badge>{call.toolType}</Badge>
                  <span className="mono tnum ml-auto shrink-0 text-[10px] text-muted-foreground">
                    {formatDurationMs(call.executionMs)}
                  </span>
                </div>
                <div className="mono mt-1 flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
                  <span>{relTime(call.createdAt)}</span>
                  {call.executedByRef !== null && <span>· by {call.executedByRef}</span>}
                </div>
                {call.error !== null && (
                  <pre className="mono mt-1.5 whitespace-pre-wrap break-words text-[10px] text-bad">
                    {call.error}
                  </pre>
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</dt>
      <dd className="mono mt-1 truncate text-foreground">{children}</dd>
    </div>
  );
}
