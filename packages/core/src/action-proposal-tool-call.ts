import type { ActionProposal } from './spi/action-proposal-store.js';
import type { UpdateToolCallInput } from './spi/agent-store.js';

/**
 * The tool-call record an independent proposal's state settles, or `null` while it has nothing to
 * say yet (pending, or approved and not yet run).
 *
 * In `actionApprovalMode: 'independent'` the turn records the call as `proposed` and ends; the
 * proposal row then carries the decision and the execution. Every store applies this on each
 * proposal transition — in the same write where it can — so the call's own record (what the
 * dashboard, the run detail and a host's audit read) follows the proposal: `executed` with its
 * output, `failed` with its error, `rejected`, or `expired` (a lapsed proposal, or one a newer
 * proposal superseded; the tool never ran either way).
 */
export function toolCallUpdateForProposal(proposal: ActionProposal): UpdateToolCallInput | null {
  const audit = proposal.decisionAudit;
  const toolCallId = proposal.originToolCallId;
  const decidedBy = {
    ...(audit?.actorRef !== undefined ? { executedByRef: audit.actorRef } : {}),
    ...(audit?.via !== undefined ? { decidedVia: audit.via } : {}),
  };
  switch (proposal.decision) {
    case 'rejected':
      return {
        toolCallId,
        status: 'rejected',
        ...decidedBy,
        ...(audit?.reason !== undefined ? { error: storableText(audit.reason) } : {}),
      };
    case 'expired':
      return {
        toolCallId,
        status: 'expired',
        ...(audit?.via !== undefined ? { decidedVia: audit.via } : {}),
      };
    case 'superseded':
      return {
        toolCallId,
        status: 'expired',
        decidedVia: audit?.via ?? 'supersession',
        error:
          proposal.supersededBy !== undefined
            ? `superseded by proposal ${proposal.supersededBy}`
            : 'superseded by a newer proposal',
      };
    case 'approved': {
      const execution = proposal.execution;
      const remember = audit?.remember !== undefined ? { remember: audit.remember } : {};
      if (execution?.status === 'succeeded') {
        return {
          toolCallId,
          status: 'executed',
          ...(storableOutput(execution.result) ? { output: execution.result } : {}),
          ...decidedBy,
          ...remember,
        };
      }
      if (execution?.status === 'failed') {
        return {
          toolCallId,
          status: 'failed',
          error: storableText(execution.error ?? 'the approved action failed'),
          ...decidedBy,
          ...remember,
        };
      }
      return null;
    }
    default:
      return null;
  }
}

/** The update a transition from `previous` to `next` calls for: `null` when the call's status stays. */
export function toolCallUpdateForTransition(
  previous: ActionProposal | undefined,
  next: ActionProposal,
): UpdateToolCallInput | null {
  const update = toolCallUpdateForProposal(next);
  if (update === null) return null;
  const before = previous === undefined ? null : toolCallUpdateForProposal(previous);
  return before?.status === update.status ? null : update;
}

/**
 * Whether a result can go into the tool call's plain `json` column on every dialect. The proposal
 * row stores its result escaped; this column does not, and Postgres refuses a `\u0000` (or a lone
 * surrogate) in `json` outright — which, inside the caller's transaction, would fail the settlement
 * itself. Such a result stays on the proposal only.
 */
function storableOutput(result: unknown): boolean {
  if (result === undefined) return false;
  let json: string | undefined;
  try {
    json = JSON.stringify(result);
  } catch {
    return false;
  }
  return (
    json !== undefined &&
    !/\\u0000|\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f])|(?<!\\ud[89ab][0-9a-f]{2})\\ud[c-f][0-9a-f]{2}/i.test(
      json,
    )
  );
}

/** Text for a plain text column: Postgres refuses NUL in `text`. */
function storableText(text: string): string {
  return text.replaceAll('\u0000', '');
}
