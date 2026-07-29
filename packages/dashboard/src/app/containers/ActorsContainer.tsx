import type { GovernanceRange } from '../../client/agent-client';
import { ActorsSection } from '../ActorsSection';
import { useSpend } from '../use-governance';

/** Actors & budgets. Shares the `spend` query — see {@link ModelsContainer}. */
export function ActorsContainer({ range }: { range: GovernanceRange }) {
  return <ActorsSection rows={useSpend(range).data.byActor} />;
}
