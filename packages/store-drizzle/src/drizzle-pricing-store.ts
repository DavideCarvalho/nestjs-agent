import type {
  AgentPricingStore,
  CurrentModelPrice,
  ModelPriceInput,
} from '@dudousxd/nestjs-agent-core';
import { and, eq } from 'drizzle-orm';
import { type AgentDrizzleDb, agentModelPricing } from './schema.js';

/**
 * {@link AgentPricingStore} backed by Drizzle ORM — the write side of the pricing table
 * {@link import('./drizzle-governance-queries.js').DrizzleGovernanceQueries} joins against. A POJO
 * receiving a Drizzle SQLite database handle (the host app owns the connection), mirroring
 * {@link import('@dudousxd/nestjs-agent-store-mikro-orm')} exactly (atomic supersede semantics).
 */
export class DrizzlePricingStore implements AgentPricingStore {
  constructor(private readonly db: AgentDrizzleDb) {}

  async upsertModelPrice(input: ModelPriceInput): Promise<void> {
    await this.db
      .update(agentModelPricing)
      .set({ isCurrent: false })
      .where(
        and(eq(agentModelPricing.modelId, input.modelId), eq(agentModelPricing.isCurrent, true)),
      );
    await this.db.insert(agentModelPricing).values({
      id: crypto.randomUUID(),
      modelId: input.modelId,
      inputPricePer1m: input.inputPricePer1m,
      outputPricePer1m: input.outputPricePer1m,
      cacheWritePricePer1m: input.cacheWritePricePer1m ?? null,
      cacheReadPricePer1m: input.cacheReadPricePer1m ?? null,
      effectiveFrom: new Date(),
      isCurrent: true,
    });
  }

  async listCurrentPrices(): Promise<CurrentModelPrice[]> {
    const rows = await this.db
      .select()
      .from(agentModelPricing)
      .where(eq(agentModelPricing.isCurrent, true));
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
