/**
 * The WRITE side of the pricing table the {@link import('./governance-queries.js').AgentGovernanceQueries}
 * read-model prices usage against. Cost is $0 for an unpriced model, so an app seeds its models'
 * per-1M rates once (and re-`upsert`s when a provider changes prices). A store adapter implements
 * this; consumers inject via `AGENT_PRICING_STORE`. Use `seedModelPrices` for a one-shot batch.
 */

/** A per-1M-token price for one model. Cache rates fall back to the input rate when omitted. */
export interface ModelPriceInput {
  modelId: string;
  inputPricePer1m: number;
  outputPricePer1m: number;
  /** Per-1M price for cache-write (prompt-cache) input tokens. Omit → priced at the input rate. */
  cacheWritePricePer1m?: number;
  /** Per-1M price for cache-read (prompt-cache) input tokens. Omit → priced at the input rate. */
  cacheReadPricePer1m?: number;
}

/** A current price row as read back, with the timestamp it took effect. */
export interface CurrentModelPrice extends ModelPriceInput {
  effectiveFrom: string;
}

export interface AgentPricingStore {
  /**
   * Set the current price for a model. Atomic supersede: the model's prior `isCurrent` row (if any)
   * is retired and this one is inserted as current, effective now — so the read-model always joins
   * to exactly one live price per model, with no window where two rows race for `isCurrent`.
   */
  upsertModelPrice(input: ModelPriceInput): Promise<void>;
  /** The current price row per model (`isCurrent`), for a pricing admin view. */
  listCurrentPrices(): Promise<CurrentModelPrice[]>;
}

/** Seed (or refresh) a batch of model prices — one `upsertModelPrice` per row, in order. */
export async function seedModelPrices(
  store: AgentPricingStore,
  prices: ModelPriceInput[],
): Promise<void> {
  for (const price of prices) {
    await store.upsertModelPrice(price);
  }
}
