import { useState } from 'react';
import type { ApprovalDecisionInput, PendingApprovalRow } from '../client/agent-client';
import { InlineError } from './SectionBoundary';
import { AlertIcon, CheckIcon, XIcon } from './icons';
import type { PagedTable } from './paged-table';
import { Empty, OpenCell, Pagination, Panel, relTime } from './ui';

/** The status prefix `agentClient.decideApproval` throws with when no `AGENT_APPROVAL_PORT` is bound. */
const APPROVAL_PORT_UNAVAILABLE_STATUS = '501';

/** A collapsed, pretty-printed tool-call input — click "input" to expand the raw JSON. */
function InputPreview({ input }: { input: unknown }) {
  return (
    <details>
      <summary className="mono w-fit cursor-pointer select-none text-[10px] text-[var(--muted)] hover:text-[var(--text)]">
        input
      </summary>
      <pre className="mono mt-1 max-w-[420px] overflow-x-auto rounded border border-[var(--line)] bg-[var(--panel-2)] p-2 text-[10px] text-[var(--text)]">
        {JSON.stringify(input, null, 2)}
      </pre>
    </details>
  );
}

/**
 * Cross-thread HITL approvals inbox: every `action` tool call sitting `pending_approval`, oldest
 * first, with Approve/Reject buttons that route through the OPTIONAL `AGENT_APPROVAL_PORT` on the
 * host. `onDecide` rejecting with a `501 ...` message (the shape `agentClient.decideApproval` throws)
 * flips this section READ-ONLY for the rest of the session — the host hasn't bound the port yet.
 *
 * PAGED, over `approvals-page`. The unpaged read this used to call is capped at 50 with no total,
 * so the 51st person waiting on a decision was invisible and nothing on screen admitted it. A queue
 * that hides its own backlog is the worst failure mode a human-in-the-loop surface has, so the
 * header states the backlog outright — "N of M" — even on page one.
 */
export function ApprovalsSection({
  table,
  onPageChange,
  onDecide,
  onOpenRun,
}: {
  table: PagedTable<PendingApprovalRow>;
  onPageChange: (page: number) => void;
  onDecide: (toolCallId: string, input: ApprovalDecisionInput) => Promise<void>;
  onOpenRun?: ((runId: string) => void) | undefined;
}) {
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [readOnly, setReadOnly] = useState(false);
  const { rows, total, page, pageSize } = table.page;

  async function decide(toolCallId: string, approved: boolean) {
    let reason: string | undefined;
    if (!approved) {
      const typed = window.prompt('Reason for rejecting (optional):');
      reason = typed !== null && typed.trim().length > 0 ? typed.trim() : undefined;
      if (typed === null) return; // the operator cancelled the prompt
    }
    setError(null);
    setPendingId(toolCallId);
    try {
      await onDecide(toolCallId, { approved, ...(reason !== undefined ? { reason } : {}) });
    } catch (decideError) {
      const message =
        decideError instanceof Error ? decideError.message : 'Failed to record the decision.';
      if (message.startsWith(APPROVAL_PORT_UNAVAILABLE_STATUS)) setReadOnly(true);
      setError(message);
    } finally {
      setPendingId(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {readOnly && (
        <div className="panel flex items-center gap-2 border-[var(--warn)]/40 p-3 text-xs text-[var(--warn)]">
          <AlertIcon />
          <span>
            No approval port is bound on this host — the inbox is READ-ONLY. Import{' '}
            <span className="mono">AgentModule</span> from{' '}
            <span className="mono">@dudousxd/nestjs-agent</span> alongside this dashboard to enable
            Approve/Reject.
          </span>
        </div>
      )}
      {error && !readOnly && (
        <div className="panel flex items-center gap-2 border-[var(--bad)]/40 p-3 text-xs text-[var(--bad)]">
          <AlertIcon />
          <span>{error}</span>
        </div>
      )}

      <Panel
        title="Approvals"
        subtitle="Action tool calls awaiting a human decision, oldest first"
        right={
          <span className="mono tnum text-[11px] text-[var(--muted)]">
            {rows.length > 0 ? `${rows.length} of ${total} waiting` : `${total} waiting`}
          </span>
        }
      >
        {table.error !== null && (
          <div className="mb-3">
            <InlineError label="Approvals inbox" error={table.error} onRetry={table.retry} />
          </div>
        )}
        {rows.length === 0 ? (
          <Empty label="No pending approvals" />
        ) : (
          <>
            <ul className="space-y-2">
              {rows.map((row) => {
                // See RunsToolsSection: bound out so the null check narrows in the handler.
                const runId = row.runId;
                return (
                  <li
                    key={row.toolCallId}
                    className="rise flex flex-col gap-2 rounded-lg border border-[var(--line)] p-3 text-xs sm:flex-row sm:items-center"
                  >
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="mono min-w-0">
                          <OpenCell
                            label={row.toolName}
                            title={runId ?? 'No run recorded for this call'}
                            onOpen={
                              onOpenRun === undefined || runId === null
                                ? undefined
                                : () => onOpenRun(runId)
                            }
                          />
                        </span>
                        <span className="truncate text-[var(--muted)]">{row.threadTitle}</span>
                        {row.agentName && (
                          <span className="mono rounded border border-[var(--line)] px-1 text-[10px] text-[var(--muted)]">
                            {row.agentName}
                          </span>
                        )}
                      </div>
                      <div className="mono flex flex-wrap items-center gap-1.5 text-[10px] text-[var(--muted)]">
                        <span>asked by {row.actorRef}</span>
                        <span>· waiting {relTime(row.requestedAt)}</span>
                      </div>
                      <InputPreview input={row.input} />
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <button
                        type="button"
                        disabled={readOnly || pendingId === row.toolCallId}
                        onClick={() => decide(row.toolCallId, true)}
                        className="flex items-center gap-1 rounded-lg border border-[var(--good)]/50 bg-[var(--good)]/10 px-2.5 py-1 text-[11px] text-[var(--good)] transition-colors hover:bg-[var(--good)]/20 disabled:opacity-50"
                      >
                        <CheckIcon /> Approve
                      </button>
                      <button
                        type="button"
                        disabled={readOnly || pendingId === row.toolCallId}
                        onClick={() => decide(row.toolCallId, false)}
                        className="flex items-center gap-1 rounded-lg border border-[var(--bad)]/50 bg-[var(--bad)]/10 px-2.5 py-1 text-[11px] text-[var(--bad)] transition-colors hover:bg-[var(--bad)]/20 disabled:opacity-50"
                      >
                        <XIcon /> Reject
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
            <Pagination page={page} pageSize={pageSize} total={total} onPage={onPageChange} />
          </>
        )}
      </Panel>
    </div>
  );
}
