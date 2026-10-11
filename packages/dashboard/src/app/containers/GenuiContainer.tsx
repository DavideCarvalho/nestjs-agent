import type { GovernanceRange } from '../../client/agent-client';
import { GenuiSection } from '../GenuiSection';
import { SectionErrorPanel, SectionSkeleton } from '../SectionBoundary';
import { useGenuiStats } from '../use-governance';

/** HTTP status the genui API 501s with when the bound store does not implement `genuiStats`. */
const GENUI_UNSUPPORTED_STATUS = '501';

/**
 * Generative UI. Like Pricing, this container does NOT hand its failures to the section boundary:
 * a `501` means the store does not record UI-tool telemetry, which the section renders as its own
 * explanatory state. Any other failure is still named, with the same panel the boundary renders.
 */
export function GenuiContainer({ range }: { range: GovernanceRange }) {
  const genui = useGenuiStats(range);

  const unavailable = genui.isError && genui.error.message.startsWith(GENUI_UNSUPPORTED_STATUS);

  if (genui.isError && !unavailable) {
    return (
      <SectionErrorPanel
        label="Generative UI"
        error={genui.error}
        onRetry={() => void genui.refetch()}
      />
    );
  }
  if (genui.isPending) {
    return <SectionSkeleton label="Generative UI" />;
  }

  return <GenuiSection stats={genui.data ?? null} unavailable={unavailable} />;
}
