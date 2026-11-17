import { parseAsString, useQueryStates } from 'nuqs';
import type { GovernanceRange, RunFilter } from '../../client/agent-client';
import { ReliabilitySection } from '../ReliabilitySection';
import { useDrillDown } from '../drill-down';
import { PAGE_SIZE, pagedTable } from '../paged-table';
import { pageParam, textParam } from '../url-state';
import { useReliability, useRunsPage } from '../use-governance';

/**
 * The recent-runs table's view state in the URL: `#/reliability?status=failed&agent=support&page=2`,
 * plus `threadId` (a thread drill-down's "show all runs on this thread" link).
 */
const RUNS_VIEW = {
  page: pageParam,
  status: textParam.withOptions({ history: 'push' }),
  agent: textParam,
  threadId: parseAsString,
};

/** Typing rewrites the current history entry, even though resetting the page alone would push. */
const TYPING = { history: 'replace' } as const;

/**
 * Reliability. Owns the reliability overview and the paged recent-runs table.
 *
 * `threadId` comes from the hash (`#/reliability?threadId=…`), which is how a thread drill-down
 * says "show me everything this thread ran" — `filter[threadId]` on `GET runs`. The thread filter
 * once 400'd as an unknown field; it works now, so the link is real rather than a plan.
 *
 * Every filter, the page included, lives in the hash's query, so the address bar never disagrees
 * with the table and a filtered table is a link. Picking a status or a page adds a history entry;
 * typing an agent name rewrites the current one. A filter change goes back to page 1.
 */
export function ReliabilityContainer({ range }: { range: GovernanceRange }) {
  const { open } = useDrillDown();
  const reliability = useReliability(range);

  const [{ page: pageNum, status, agent: agentName, threadId }, setView] =
    useQueryStates(RUNS_VIEW);

  const where: RunFilter = {
    ...(status !== '' ? { status } : {}),
    ...(agentName !== '' ? { agentName } : {}),
    ...(threadId !== null && threadId !== '' ? { threadId } : {}),
  };
  const runsQuery = useRunsPage(pageNum, PAGE_SIZE, where);

  return (
    <ReliabilitySection
      overview={reliability.data}
      runsTable={pagedTable(runsQuery, pageNum, PAGE_SIZE)}
      runsFilter={where}
      onRunsStatusChange={(value) => void setView({ status: value, page: null })}
      onRunsAgentNameChange={(value) => void setView({ agent: value, page: null }, TYPING)}
      onRunsThreadIdClear={() => void setView({ threadId: null, page: null }, { history: 'push' })}
      onRunsPageChange={(next) => void setView({ page: next })}
      onOpenRun={(runId) => open({ kind: 'run', runId })}
    />
  );
}
