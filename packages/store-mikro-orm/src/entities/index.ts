import type { EntitySchema } from '@mikro-orm/core';
import { agentMessageSchema } from './agent-message.entity';
import { agentModelPricingSchema } from './agent-model-pricing.entity';
import { agentRunSchema } from './agent-run.entity';
import { agentThreadSchema } from './agent-thread.entity';
import { agentTokenUsageSchema } from './agent-token-usage.entity';
import { agentToolCallSchema } from './agent-tool-call.entity';
import { ragIngestionLogSchema } from './rag-ingestion-log.entity';

export * from './rag-ingestion-log.entity';
export * from './agent-thread.entity';
export * from './agent-message.entity';
export * from './agent-tool-call.entity';
export * from './agent-token-usage.entity';
export * from './agent-model-pricing.entity';
export * from './agent-run.entity';

/** Default string collation baked into {@link AGENT_ENTITIES} for MySQL parity (§5). */
export const AGENT_COLLATION = 'utf8mb4_unicode_ci';

/**
 * Builds the seven agent entity schemas. Pass `collation` to stamp string columns for
 * MySQL parity; omit it for engines (e.g. SQLite) that reject named collations.
 */
export function agentEntities(options: { collation?: string } = {}): EntitySchema[] {
  return [
    agentThreadSchema(options.collation),
    agentMessageSchema(options.collation),
    agentToolCallSchema(options.collation),
    agentTokenUsageSchema(options.collation),
    agentModelPricingSchema(options.collation),
    agentRunSchema(options.collation),
    ragIngestionLogSchema(options.collation),
  ];
}

/** The canonical entity set registered by {@link MikroOrmAgentStoreModule} (MySQL collation). */
export const AGENT_ENTITIES = agentEntities({ collation: AGENT_COLLATION });
