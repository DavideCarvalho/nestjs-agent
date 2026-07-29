import type { GovernanceRange } from '../../client/agent-client';
import { ModelsSection } from '../ModelsSection';
import { useSpend } from '../use-governance';

/**
 * Models. Reads the same `spend` query as {@link SpendContainer} and {@link ActorsContainer} — same
 * key, so react-query serves it from cache and moving between the three costs nothing. That is the
 * point of one query per container rather than one query per SECTION: sharing is the cache's job.
 */
export function ModelsContainer({ range }: { range: GovernanceRange }) {
  return <ModelsSection rows={useSpend(range).data.byModel} />;
}
