import { EntitySchema } from '@mikro-orm/core';

/** Per-model token pricing, versioned by `effectiveFrom`; `isCurrent` flags the live row. */
export class AgentModelPricing {
  id!: string;
  modelId!: string;
  inputPricePer1m!: number;
  outputPricePer1m!: number;
  effectiveFrom!: Date;
  isCurrent!: boolean;
}

/** Builds the `agent_model_pricing` schema. */
export function agentModelPricingSchema(collation?: string): EntitySchema<AgentModelPricing> {
  const str = collation !== undefined ? { collation } : {};
  return new EntitySchema<AgentModelPricing>({
    class: AgentModelPricing,
    tableName: 'agent_model_pricing',
    properties: {
      id: { type: 'string', primary: true, ...str },
      modelId: { type: 'string', fieldName: 'model_id', ...str },
      inputPricePer1m: { type: 'float', fieldName: 'input_price_per_1m' },
      outputPricePer1m: { type: 'float', fieldName: 'output_price_per_1m' },
      effectiveFrom: { type: 'datetime', fieldName: 'effective_from' },
      isCurrent: { type: 'boolean', fieldName: 'is_current' },
    },
  });
}
