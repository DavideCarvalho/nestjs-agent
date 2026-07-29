import type { GovernanceRange } from '../../client/agent-client';
import { SpendSection } from '../SpendSection';
import { useDrillDown } from '../drill-down';
import { useSpendSection } from '../use-governance';

/**
 * Spend & usage. Owns the two reads it renders — the overview and top-threads-by-cost — instead of
 * being handed them by `App`, so opening any OTHER section no longer pays for this one.
 *
 * The two go through `useSpendSection` rather than two hooks side by side; see the waterfall note
 * in `use-governance.ts` for why that distinction is load-bearing rather than stylistic.
 */
export function SpendContainer({ range }: { range: GovernanceRange }) {
  const { open } = useDrillDown();
  const { overview, topThreads } = useSpendSection(range);

  return (
    <SpendSection
      overview={overview}
      topThreads={topThreads}
      onOpenThread={(threadId) => open({ kind: 'thread', threadId })}
    />
  );
}
