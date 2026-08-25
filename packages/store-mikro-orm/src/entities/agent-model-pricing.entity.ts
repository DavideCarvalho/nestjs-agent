import { EntityRepository, EntityRepositoryType, EntitySchema } from '@mikro-orm/core';

/** Per-model token pricing, versioned by `effectiveFrom`; `isCurrent` flags the live row. */
export class AgentModelPricing {
  id!: string;
  modelId!: string;
  inputPricePer1m!: number;
  outputPricePer1m!: number;
  /** Per-1M price for cache-write (prompt-cache) input tokens; null → price them at the input rate. */
  cacheWritePricePer1m?: number | null;
  /** Per-1M price for cache-read (prompt-cache) input tokens; null → price them at the input rate. */
  cacheReadPricePer1m?: number | null;
  effectiveFrom!: Date;
  isCurrent!: boolean;
  [EntityRepositoryType]?: AgentModelPricingRepository;
}

/** Custom repository for {@link AgentModelPricing}, so a host can inject it by type instead of passing the entity to every `em` call. */
export class AgentModelPricingRepository extends EntityRepository<AgentModelPricing> {}

/** Builds the `agent_model_pricing` schema. */
export function agentModelPricingSchema(collation?: string): EntitySchema<AgentModelPricing> {
  const str = collation !== undefined ? { collation } : {};
  return new EntitySchema<AgentModelPricing>({
    class: AgentModelPricing,
    tableName: 'agent_model_pricing',
    repository: () => AgentModelPricingRepository,
    properties: {
      id: { type: 'string', primary: true, ...str },
      modelId: { type: 'string', fieldName: 'model_id', ...str },
      inputPricePer1m: { type: 'float', fieldName: 'input_price_per_1m' },
      outputPricePer1m: { type: 'float', fieldName: 'output_price_per_1m' },
      cacheWritePricePer1m: {
        type: 'float',
        nullable: true,
        fieldName: 'cache_write_price_per_1m',
      },
      cacheReadPricePer1m: { type: 'float', nullable: true, fieldName: 'cache_read_price_per_1m' },
      effectiveFrom: { type: 'datetime', fieldName: 'effective_from' },
      isCurrent: { type: 'boolean', fieldName: 'is_current' },
    },
  });
}
