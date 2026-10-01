import type {
  AgentPricingStore,
  CurrentModelPrice,
  ModelPriceInput,
} from '@dudousxd/nestjs-agent-core';
import { and, eq } from 'drizzle-orm';
import {
  type AgentDialect,
  type AgentDrizzleDb,
  type AgentSqliteDb,
  type AgentTables,
  agentDialectOf,
  agentTablesFor,
  asBuilder,
} from './dialect.js';
import { agentModelPricing } from './schema.js';

/**
 * {@link AgentPricingStore} backed by Drizzle ORM — the write side of the pricing table
 * {@link import('./drizzle-governance-queries.js').DrizzleGovernanceQueries} joins against. A POJO
 * receiving a Drizzle SQLite database handle (the host app owns the connection), mirroring
 * {@link import('@dudousxd/nestjs-agent-store-mikro-orm')} exactly (atomic supersede semantics).
 */
export class DrizzlePricingStore implements AgentPricingStore {
  private readonly db: AgentSqliteDb;
  private readonly dialect: AgentDialect;
  private readonly t: AgentTables;

  constructor(db: AgentDrizzleDb) {
    this.dialect = agentDialectOf(db);
    this.t = agentTablesFor(this.dialect);
    this.db = asBuilder(db);
  }

  async upsertModelPrice(input: ModelPriceInput): Promise<void> {
    await this.db
      .update(this.t.agentModelPricing)
      .set({ isCurrent: false })
      .where(
        and(
          eq(this.t.agentModelPricing.modelId, input.modelId),
          eq(this.t.agentModelPricing.isCurrent, true),
        ),
      );
    await this.db.insert(this.t.agentModelPricing).values({
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
      .from(this.t.agentModelPricing)
      .where(eq(this.t.agentModelPricing.isCurrent, true));
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
