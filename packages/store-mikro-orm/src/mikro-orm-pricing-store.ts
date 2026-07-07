import type {
  AgentPricingStore,
  CurrentModelPrice,
  ModelPriceInput,
} from '@dudousxd/nestjs-agent-core';
import type { EntityManager } from '@mikro-orm/core';
import { AgentModelPricing } from './entities/agent-model-pricing.entity';

/**
 * {@link AgentPricingStore} backed by MikroORM. A POJO receiving an {@link EntityManager}; each
 * operation runs on a fresh `em.fork()`. `upsertModelPrice` supersedes atomically in one flush, so
 * `AgentModelPricing.isCurrent` never has more than one live row per model.
 */
export class MikroOrmPricingStore implements AgentPricingStore {
  constructor(private readonly em: EntityManager) {}

  async upsertModelPrice(input: ModelPriceInput): Promise<void> {
    const em = this.em.fork();
    await em.nativeUpdate(
      AgentModelPricing,
      { modelId: input.modelId, isCurrent: true },
      { isCurrent: false },
    );
    const price = em.create(AgentModelPricing, {
      id: crypto.randomUUID(),
      modelId: input.modelId,
      inputPricePer1m: input.inputPricePer1m,
      outputPricePer1m: input.outputPricePer1m,
      cacheWritePricePer1m: input.cacheWritePricePer1m ?? null,
      cacheReadPricePer1m: input.cacheReadPricePer1m ?? null,
      effectiveFrom: new Date(),
      isCurrent: true,
    });
    em.persist(price);
    await em.flush();
  }

  async listCurrentPrices(): Promise<CurrentModelPrice[]> {
    const em = this.em.fork();
    const rows = await em.find(AgentModelPricing, { isCurrent: true });
    return rows.map((row) => ({
      modelId: row.modelId,
      inputPricePer1m: row.inputPricePer1m,
      outputPricePer1m: row.outputPricePer1m,
      effectiveFrom: row.effectiveFrom.toISOString(),
      ...(row.cacheWritePricePer1m != null
        ? { cacheWritePricePer1m: row.cacheWritePricePer1m }
        : {}),
      ...(row.cacheReadPricePer1m != null ? { cacheReadPricePer1m: row.cacheReadPricePer1m } : {}),
    }));
  }
}
