import type { ReactNode } from 'react';
import type { RunDetail } from '../client/agent-client';
import { formatDurationMs, formatUsd } from '../client/format-usd';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Empty, Panel, StatusPill, relTime } from './ui/kit';

/**
 * A run drill-down: the run's outcome, the FULL error text a table row could only truncate, and the
 * tool calls it made in the order it requested them.
 *
 * Cost, time to first token and model come off the run row itself (`recordRunEnd`), written by the
 * run that spent them. They are shown only when the row has them — a run recorded before they
 * existed, or one that never completed, shows no figure rather than a plausible-looking `0`, which
 * would be worse than a missing one on a governance screen.
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
          {run.ttftMs !== null && (
            <Field label="Time to first token">{formatDurationMs(run.ttftMs)}</Field>
          )}
          {run.costUsd !== null && <Field label="Cost">{formatUsd(run.costUsd)}</Field>}
          {run.modelId !== null && <Field label="Model">{run.modelId}</Field>}
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

        {run.parentRunId !== null && (
          <div className="mono mt-3 text-[10px] text-muted-foreground">
            delegated by <span className="text-foreground">{run.parentRunId}</span>
          </div>
        )}

        {run.promptHash !== null && (
          <div className="mono mt-3 text-[10px] text-muted-foreground">
            prompt sha256 <span className="text-foreground">{run.promptHash}</span>
          </div>
        )}
      </Panel>

      <TimingPanel detail={detail} />

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

/**
 * Where a run's time went: queue / model / tools, the rest of the wall-clock (persistence, approval
 * and delegation waits) as "other", and each step's model time and tool calls. Absent when the server
 * recorded no timings for the run (an older server, a run that did not complete).
 */
export function TimingPanel({ detail }: { detail: RunDetail }) {
  const { run, timings } = detail;
  if ((timings === null || timings === undefined) && (run.queueMs ?? null) === null) return null;
  const model = timings?.modelMs ?? 0;
  const tools = timings?.toolsMs ?? 0;
  const parts = [
    { label: 'Queue', ms: run.queueMs ?? 0, tone: 'bg-muted-foreground/50' },
    { label: 'Model', ms: model, tone: 'bg-accent' },
    { label: 'Tools', ms: tools, tone: 'bg-good' },
    {
      label: 'Other',
      ms: run.durationMs === null ? 0 : Math.max(0, run.durationMs - model - tools),
      tone: 'bg-line',
    },
  ];
  const total = parts.reduce((sum, part) => sum + part.ms, 0);
  return (
    <Panel
      title="Where the time went"
      subtitle={
        timings
          ? `${timings.modelCalls} model calls · ${timings.toolCalls} tool calls`
          : 'queue time only'
      }
    >
      <div
        className="flex h-2.5 gap-px overflow-hidden rounded"
        role="img"
        aria-label={parts.map((part) => `${part.label} ${formatDurationMs(part.ms)}`).join(', ')}
      >
        {parts.map((part) =>
          part.ms > 0 && total > 0 ? (
            <span
              key={part.label}
              className={part.tone}
              title={`${part.label}: ${formatDurationMs(part.ms)}`}
              style={{ flex: part.ms / total }}
            />
          ) : null,
        )}
      </div>
      <dl className="mt-3 grid grid-cols-4 gap-x-4 text-xs">
        {parts.map((part) => (
          <Field key={part.label} label={part.label}>
            {formatDurationMs(part.ms)}
          </Field>
        ))}
      </dl>
      {timings && timings.steps.length > 0 && (
        <ul className="mt-3 space-y-1">
          {timings.steps.map((step) => (
            <li key={step.step} className="mono flex flex-wrap gap-2 text-[11px]">
              <span className="text-muted-foreground">step {step.step + 1}</span>
              <span>model {formatDurationMs(step.modelMs ?? null)}</span>
              {step.tools.length > 0 && (
                <span className="text-muted-foreground">
                  tools {formatDurationMs(step.toolsMs)} —{' '}
                  {step.tools
                    .map((tool) => `${tool.toolName} ${formatDurationMs(tool.ms)}`)
                    .join(' · ')}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
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
