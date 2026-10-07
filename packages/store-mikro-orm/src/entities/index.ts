import type { EntitySchema } from '@mikro-orm/core';
import { agentActionProposalSchema } from './agent-action-proposal.entity';
import { agentChannelStateSchema } from './agent-channel-state.entity';
import { agentConfirmTokenSchema } from './agent-confirm-token.entity';
import { agentMemorySchema } from './agent-memory.entity';
import { agentMessageSchema } from './agent-message.entity';
import { agentModelPricingSchema } from './agent-model-pricing.entity';
import { agentQueuedMessageSchema } from './agent-queued-message.entity';
import { agentRunSchema } from './agent-run.entity';
import { agentStreamFrameSchema } from './agent-stream-frame.entity';
import { agentThreadSchema } from './agent-thread.entity';
import { agentTokenUsageSchema } from './agent-token-usage.entity';
import { agentToolCallSchema } from './agent-tool-call.entity';
import { ragIngestionLogSchema } from './rag-ingestion-log.entity';

export * from './rag-ingestion-log.entity';
export * from './agent-thread.entity';
export * from './agent-memory.entity';
export * from './agent-message.entity';
export * from './agent-queued-message.entity';
export * from './agent-tool-call.entity';
export * from './agent-token-usage.entity';
export * from './agent-model-pricing.entity';
export * from './agent-run.entity';
export * from './agent-stream-frame.entity';
export * from './agent-confirm-token.entity';
export * from './agent-channel-state.entity';
export * from './agent-action-proposal.entity';

/** Default string collation baked into {@link AGENT_ENTITIES} for MySQL parity (§5). */
export const AGENT_COLLATION = 'utf8mb4_unicode_ci';

/**
 * Builds the agent entity schemas. Pass `collation` to stamp string columns for
 * MySQL parity; omit it for engines (e.g. SQLite) that reject named collations.
 */
export function agentEntities(options: { collation?: string } = {}): EntitySchema[] {
  return [
    agentActionProposalSchema(options.collation),
    agentThreadSchema(options.collation),
    agentMessageSchema(options.collation),
    agentQueuedMessageSchema(options.collation),
    agentToolCallSchema(options.collation),
    agentTokenUsageSchema(options.collation),
    agentModelPricingSchema(options.collation),
    agentRunSchema(options.collation),
    agentMemorySchema(options.collation),
    ragIngestionLogSchema(options.collation),
    agentStreamFrameSchema(options.collation),
    agentConfirmTokenSchema(options.collation),
    agentChannelStateSchema(options.collation),
  ];
}

/**
 * The canonical entity set (MySQL collation), for the host's own MikroORM config:
 * `entities: [...yourEntities, ...AGENT_ENTITIES]`. `MikroOrmAgentStoreModule.forFeature()` does not
 * register entities — the shared ORM's discovery has to see them, and only the host's config feeds it.
 * Use {@link agentEntities} for another collation, or none (SQLite).
 */
export const AGENT_ENTITIES = agentEntities({ collation: AGENT_COLLATION });
