import { useState } from 'react';
import { ApprovalsSection } from '../ApprovalsSection';
import { useDrillDown } from '../drill-down';
import { PAGE_SIZE, pagedTable } from '../paged-table';
import { useApprovalsPage, useDecideApproval } from '../use-governance';

/**
 * Approvals. Owns the paged inbox and the decide mutation.
 *
 * The inbox reads `approvals-page`, not the capped `approvals` this console used to call: a queue
 * that silently truncates at 50 is the one table here where being wrong costs someone a decision
 * nobody made.
 */
export function ApprovalsContainer() {
  const { open } = useDrillDown();
  const [page, setPage] = useState(1);
  const approvals = useApprovalsPage(page, PAGE_SIZE, {});
  const decide = useDecideApproval();

  return (
    <ApprovalsSection
      table={pagedTable(approvals, page, PAGE_SIZE)}
      onPageChange={setPage}
      onDecide={(toolCallId, input) => decide.mutateAsync({ toolCallId, input })}
      onOpenRun={(runId) => open({ kind: 'run', runId })}
    />
  );
}
