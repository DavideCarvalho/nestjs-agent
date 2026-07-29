import type { GovernanceRange } from '../../client/agent-client';
import { ToolsSection } from '../ToolsSection';
import { useToolStats } from '../use-governance';

/** Tools. One aggregate read, which now carries p50 alongside p95. */
export function ToolsContainer({ range }: { range: GovernanceRange }) {
  return <ToolsSection rows={useToolStats(range).data} />;
}
