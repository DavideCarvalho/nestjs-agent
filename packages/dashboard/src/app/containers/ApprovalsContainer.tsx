import { useQueryState } from 'nuqs';
import { ApprovalsSection } from '../ApprovalsSection';
import { useDrillDown } from '../drill-down';
import { PAGE_SIZE, pagedTable } from '../paged-table';
import { pageParam } from '../url-state';
import { useApprovalsPage, useDecideApproval } from '../use-governance';

/**
 * Approvals. Owns the paged inbox and the decide mutation.
 *
 * The inbox reads `GET approvals` as a paged list with a total, not the capped array it once was:
 * a queue that silently truncates at 50 is the one table here where being wrong costs someone a
 * decision nobody made.
 */
export function ApprovalsContainer() {
  const { open } = useDrillDown();
  // `?page=2`; page 1 has no param. Paging adds a history entry.
  const [page, setPage] = useQueryState('page', pageParam);
  const approvals = useApprovalsPage(page, PAGE_SIZE, {});
  const decide = useDecideApproval();

  return (
    <ApprovalsSection
      table={pagedTable(approvals, page, PAGE_SIZE)}
      onPageChange={(next) => void setPage(next)}
      onDecide={(toolCallId, input) => decide.mutateAsync({ toolCallId, input })}
      onOpenRun={(runId) => open({ kind: 'run', runId })}
    />
  );
}
