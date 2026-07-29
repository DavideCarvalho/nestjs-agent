import { PricingSection } from '../PricingSection';
import { SectionErrorPanel } from '../SectionBoundary';
import { usePricing, useUpsertPrice } from '../use-governance';

/** HTTP status the pricing API 501s with when no `AGENT_PRICING_STORE` is bound. */
const PRICING_UNAVAILABLE_STATUS = '501';

/**
 * Pricing. The one container that does NOT hand its failures to the section boundary, because one
 * of them is not a failure: a `501` means the host bound no pricing store, which the section already
 * renders as its own explanatory state. Everything else — a 500, an unreachable API — still has to
 * be named rather than shown as an empty price table, so it gets the same panel the boundary would
 * have rendered, driven by `refetch` instead of a remount.
 */
export function PricingContainer() {
  const pricing = usePricing();
  const upsert = useUpsertPrice();

  const unavailable =
    pricing.isError && pricing.error.message.startsWith(PRICING_UNAVAILABLE_STATUS);

  if (pricing.isError && !unavailable) {
    return (
      <SectionErrorPanel
        label="Pricing"
        error={pricing.error}
        onRetry={() => void pricing.refetch()}
      />
    );
  }

  return (
    <PricingSection
      prices={pricing.data ?? []}
      loading={pricing.isPending}
      unavailable={unavailable}
      onUpsert={(input) => upsert.mutateAsync(input)}
      saving={upsert.isPending}
    />
  );
}
