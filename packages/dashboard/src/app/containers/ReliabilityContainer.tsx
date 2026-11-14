import { useState } from 'react';
import type { GovernanceRange, RunFilter } from '../../client/agent-client';
import { ReliabilitySection } from '../ReliabilitySection';
import { useDrillDown } from '../drill-down';
import { hashForSection } from '../hash-section';
import { PAGE_SIZE, pagedTable } from '../paged-table';
import { useReliability, useRunsPage } from '../use-governance';

/**
 * Reliability. Owns the reliability overview and the paged recent-runs table.
 *
 * `threadId` comes from the hash (`#/reliability?threadId=…`), which is how a thread drill-down
 * says "show me everything this thread ran" — `filter[threadId]` on `GET runs`. The thread filter
 * once 400'd as an unknown field; it works now, so the link is real rather than a plan.
 *
 * Dismissing that filter navigates rather than setting local state, so the address bar never
 * disagrees with the table — a URL that still says `?threadId=th2` next to an unfiltered table is
 * a link that lies the next time someone pastes it.
 */
export function ReliabilityContainer({
  range,
  threadId,
}: {
  range: GovernanceRange;
  threadId?: string | undefined;
}) {
  const { open } = useDrillDown();
  const reliability = useReliability(range);

  const [pageNum, setPageNum] = useState(1);
  const [status, setStatus] = useState('');
  const [agentName, setAgentName] = useState('');

  const where: RunFilter = {
    ...(status !== '' ? { status } : {}),
    ...(agentName !== '' ? { agentName } : {}),
    ...(threadId !== undefined && threadId !== '' ? { threadId } : {}),
  };
  const runsQuery = useRunsPage(pageNum, PAGE_SIZE, where);

  return (
    <ReliabilitySection
      overview={reliability.data}
      runsTable={pagedTable(runsQuery, pageNum, PAGE_SIZE)}
      runsFilter={where}
      onRunsStatusChange={(value) => {
        setStatus(value);
        setPageNum(1);
      }}
      onRunsAgentNameChange={(value) => {
        setAgentName(value);
        setPageNum(1);
      }}
      onRunsThreadIdClear={() => {
        setPageNum(1);
        window.location.hash = hashForSection('reliability');
      }}
      onRunsPageChange={setPageNum}
      onOpenRun={(runId) => open({ kind: 'run', runId })}
    />
  );
}
