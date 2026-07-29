import { useState } from 'react';
import type { ApprovalDecisionInput, PendingApprovalRow } from '../client/agent-client';
import { InlineError } from './SectionBoundary';
import { AlertIcon, CheckIcon, XIcon } from './icons';
import type { PagedTable } from './paged-table';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { Empty, OpenCell, Pagination, Panel, relTime } from './ui/kit';

/** The status prefix `agentClient.decideApproval` throws with when no `AGENT_APPROVAL_PORT` is bound. */
const APPROVAL_PORT_UNAVAILABLE_STATUS = '501';

/** A collapsed, pretty-printed tool-call input — click "input" to expand the raw JSON. */
function InputPreview({ input }: { input: unknown }) {
  return (
    <details>
      <summary className="mono w-fit cursor-pointer select-none text-[10px] text-muted-foreground hover:text-foreground">
        input
      </summary>
      <pre className="mono mt-1 max-w-[420px] overflow-x-auto rounded border border-line bg-panel-2 p-2 text-[10px] text-foreground">
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
        <Card className="flex items-center gap-2 border-warn/40 p-3 text-xs text-warn">
          <AlertIcon />
          <span>
            No approval port is bound on this host — the inbox is READ-ONLY. Import{' '}
            <span className="mono">AgentModule</span> from{' '}
            <span className="mono">@dudousxd/nestjs-agent</span> alongside this dashboard to enable
            Approve/Reject.
          </span>
        </Card>
      )}
      {error && !readOnly && (
        <Card className="flex items-center gap-2 border-bad/40 p-3 text-xs text-bad">
          <AlertIcon />
          <span>{error}</span>
        </Card>
      )}

      <Panel
        title="Approvals"
        subtitle="Action tool calls awaiting a human decision, oldest first"
        right={
          <span className="mono tnum text-[11px] text-muted-foreground">
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
                    className="rise flex flex-col gap-2 rounded-lg border border-line p-3 text-xs sm:flex-row sm:items-center"
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
                        <span className="truncate text-muted-foreground">{row.threadTitle}</span>
                        {row.agentName && <Badge>{row.agentName}</Badge>}
                      </div>
                      <div className="mono flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
                        <span>asked by {row.actorRef}</span>
                        <span>· waiting {relTime(row.requestedAt)}</span>
                      </div>
                      <InputPreview input={row.input} />
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Button
                        variant="success"
                        className="rounded-lg"
                        disabled={readOnly || pendingId === row.toolCallId}
                        onClick={() => decide(row.toolCallId, true)}
                      >
                        <CheckIcon /> Approve
                      </Button>
                      <Button
                        variant="danger"
                        className="rounded-lg"
                        disabled={readOnly || pendingId === row.toolCallId}
                        onClick={() => decide(row.toolCallId, false)}
                      >
                        <XIcon /> Reject
                      </Button>
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
