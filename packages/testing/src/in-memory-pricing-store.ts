import type {
  AgentPricingStore,
  CurrentModelPrice,
  ModelPriceInput,
} from '@dudousxd/nestjs-agent-core';

/** A fully in-memory `AgentPricingStore` for tests and the offline demo. */
export class InMemoryPricingStore implements AgentPricingStore {
  private readonly prices = new Map<string, CurrentModelPrice>();

  async upsertModelPrice(input: ModelPriceInput): Promise<void> {
    this.prices.set(input.modelId, {
      modelId: input.modelId,
      inputPricePer1m: input.inputPricePer1m,
      outputPricePer1m: input.outputPricePer1m,
      effectiveFrom: new Date().toISOString(),
      ...(input.cacheWritePricePer1m !== undefined
        ? { cacheWritePricePer1m: input.cacheWritePricePer1m }
        : {}),
      ...(input.cacheReadPricePer1m !== undefined
        ? { cacheReadPricePer1m: input.cacheReadPricePer1m }
        : {}),
    });
  }

  async listCurrentPrices(): Promise<CurrentModelPrice[]> {
    return [...this.prices.values()];
  }
}
