import type { AgentGovernanceQueries } from '@dudousxd/nestjs-agent-core';

/**
 * The corpus behind {@link import('./scorers/approval-risk.scorer.js').ApprovalRiskScorer}: how
 * often humans have approved each `action` tool, across every HITL decision the store holds.
 */

/** One recorded human decision on an `action` tool call. */
export interface ToolApprovalDecision {
  toolName: string;
  /** The tool call's final status, as the store recorded it. */
  status: string;
}

/** How a single tool has fared with humans. */
export interface ToolApprovalCounts {
  approved: number;
  rejected: number;
}

/** Approval counts per tool name. */
export type ToolApprovalPrior = ReadonlyMap<string, ToolApprovalCounts>;

/** See `APPROVED_STATUSES` in the approval-outcome scorer — an approved action can still end `failed`. */
const APPROVED_STATUSES = new Set(['executed', 'failed']);

/**
 * Pseudo-counts of a Beta(1,1) prior — one imagined approval and one imagined rejection per tool.
 *
 * Without it a tool rejected once out of one call scores 0.0 and a tool approved once out of one
 * scores 1.0, and the whole ranking is decided by whichever tool happened to be used first. With
 * it, an unseen tool sits at exactly 0.5 ("no evidence either way") and evidence moves it as it
 * accumulates — 1-of-1 rejected reads 0.33, 1-of-6 reads 0.25, 0-of-50 reads 0.02.
 */
const PRIOR_PSEUDO_COUNT = 1;

/** Fold recorded decisions into per-tool approval counts. Undecided statuses are ignored. */
export function buildApprovalPrior(
  decisions: Iterable<ToolApprovalDecision>,
): Map<string, ToolApprovalCounts> {
  const prior = new Map<string, ToolApprovalCounts>();
  for (const decision of decisions) {
    const approved = APPROVED_STATUSES.has(decision.status);
    if (!approved && decision.status !== 'rejected') {
      continue;
    }
    const counts = prior.get(decision.toolName) ?? { approved: 0, rejected: 0 };
    if (approved) {
      counts.approved += 1;
    } else {
      counts.rejected += 1;
    }
    prior.set(decision.toolName, counts);
  }
  return prior;
}

/**
 * The smoothed probability that a human approves this tool the next time it is proposed. `0.5` for
 * a tool nobody has ever decided on, which is what "we have no evidence" should look like.
 */
export function approvalPosterior(counts: ToolApprovalCounts | undefined): number {
  const approved = counts?.approved ?? 0;
  const rejected = counts?.rejected ?? 0;
  return (approved + PRIOR_PSEUDO_COUNT) / (approved + rejected + PRIOR_PSEUDO_COUNT * 2);
}

/** How much decision history {@link loadApprovalPrior} reads. */
export interface ApprovalPriorQuery {
  /** Inclusive UTC day bounds on when the call was made, `YYYY-MM-DD`. */
  fromDay?: string;
  toDay?: string;
  /** Rows per page while walking the history. */
  pageSize?: number;
  /**
   * Bound on the history read, so building a prior can never turn into an unbounded scan. Tested
   * between pages, so the walk stops once this many rows are in hand — the page that reaches the
   * bound is folded in whole, carrying up to `pageSize - 1` rows past it.
   */
  maxRows?: number;
}

const DEFAULT_PAGE_SIZE = 500;
const DEFAULT_MAX_ROWS = 20_000;

/**
 * Build the prior from a store's own HITL history, by paging the governance tool-call feed for
 * `action` calls. Offline by construction: it reads decisions humans already made, so a batch can
 * score a whole backlog against the taste of the people who have been running the system.
 */
export async function loadApprovalPrior(
  queries: AgentGovernanceQueries,
  query: ApprovalPriorQuery = {},
): Promise<Map<string, ToolApprovalCounts>> {
  const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxRows = query.maxRows ?? DEFAULT_MAX_ROWS;
  const decisions: ToolApprovalDecision[] = [];
  for (let page = 1; decisions.length < maxRows; page += 1) {
    const result = await queries.toolCallsPage({
      page,
      pageSize,
      where: {
        toolType: 'action',
        ...(query.fromDay !== undefined ? { fromDay: query.fromDay } : {}),
        ...(query.toDay !== undefined ? { toDay: query.toDay } : {}),
      },
    });
    for (const row of result.rows) {
      decisions.push({ toolName: row.toolName, status: row.status });
    }
    if (result.rows.length === 0 || page * pageSize >= result.total) {
      break;
    }
  }
  return buildApprovalPrior(decisions);
}
