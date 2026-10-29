import type { CostSource, UsagePurpose } from '@dudousxd/nestjs-agent-core';
import { EntityRepository, EntityRepositoryType, EntitySchema } from '@mikro-orm/core';
import { AgentThread } from './agent-thread.entity';
import { DATETIME, identityCollation } from './column-types';

/** A token-usage ledger row, summed per actor per day by {@link MikroOrmAgentStore.quotaToday}. */
export class AgentTokenUsage {
  id!: string;
  /** NULL for usage recorded outside any conversation (`AgentService.recordUsage`). */
  thread?: AgentThread | null;
  actorRef!: string;
  messageId?: string | null;
  modelId!: string;
  purpose!: UsagePurpose;
  inputTokens!: number;
  outputTokens!: number;
  /** Subset of `inputTokens` written to the prompt cache this turn; null when not reported. */
  cacheWriteTokens?: number | null;
  /** Subset of `inputTokens` served from the prompt cache this turn; null when not reported. */
  cacheReadTokens?: number | null;
  /** The turn's USD cost: provider-reported, or estimated from the price row (see `costSource`); null when unpriced. */
  costUsd?: number | null;
  /** Where `costUsd` came from: `'provider'` or `'estimate'`; null on rows from before it existed (reported). */
  costSource?: CostSource | null;
  runId?: string | null;
  /** What the spend was for: `agent:<name>` for an agent turn, the app's own otherwise; null → `agent`. */
  feature?: string | null;
  provider?: string | null;
  tenantRef?: string | null;
  audioSeconds?: number | null;
  characters?: number | null;
  requests?: number | null;
  metadata?: Record<string, unknown> | null;
  createdAt!: Date;
  declare [EntityRepositoryType]?: AgentTokenUsageRepository;
}

/** Custom repository for {@link AgentTokenUsage}, so a host can inject it by type instead of passing the entity to every `em` call. */
export class AgentTokenUsageRepository extends EntityRepository<AgentTokenUsage> {}

/** Builds the `agent_token_usage` schema. `thread` cascades on delete (§5). */
export function agentTokenUsageSchema(collation?: string): EntitySchema<AgentTokenUsage> {
  const str = collation !== undefined ? { collation } : {};
  const identity = identityCollation(collation);
  return new EntitySchema<AgentTokenUsage>({
    class: AgentTokenUsage,
    tableName: 'agent_token_usage',
    repository: () => AgentTokenUsageRepository,
    // `thread` unnamed for the reason `agent_tool_call` declares `message`: MySQL and SQLite already
    // carry the ORM's own index on the many-to-one, Postgres does not.
    indexes: [
      { name: 'agent_token_usage_actor_created_idx', properties: ['actorRef', 'createdAt'] },
      { name: 'agent_token_usage_created_idx', properties: ['createdAt'] },
      { properties: ['thread'] },
      { name: 'agent_token_usage_feature_created_idx', properties: ['feature', 'createdAt'] },
    ],
    properties: {
      id: { type: 'string', primary: true, ...str },
      thread: {
        kind: 'm:1',
        entity: () => AgentThread,
        deleteRule: 'cascade',
        nullable: true,
        fieldName: 'thread_id',
        ...str,
      },
      actorRef: { type: 'string', fieldName: 'actor_ref', ...identity },
      messageId: { type: 'string', nullable: true, fieldName: 'message_id', ...str },
      modelId: { type: 'string', fieldName: 'model_id', ...str },
      purpose: { type: 'string', ...str },
      inputTokens: { type: 'integer', fieldName: 'input_tokens' },
      outputTokens: { type: 'integer', fieldName: 'output_tokens' },
      cacheWriteTokens: { type: 'integer', nullable: true, fieldName: 'cache_write_tokens' },
      cacheReadTokens: { type: 'integer', nullable: true, fieldName: 'cache_read_tokens' },
      costUsd: { type: 'float', nullable: true, fieldName: 'cost_usd' },
      costSource: { type: 'string', length: 16, nullable: true, fieldName: 'cost_source', ...str },
      runId: { type: 'string', nullable: true, fieldName: 'run_id', ...str },
      feature: { type: 'string', nullable: true, ...str },
      provider: { type: 'string', nullable: true, ...str },
      tenantRef: { type: 'string', nullable: true, fieldName: 'tenant_ref', ...str },
      audioSeconds: { type: 'float', nullable: true, fieldName: 'audio_seconds' },
      characters: { type: 'integer', nullable: true },
      requests: { type: 'integer', nullable: true },
      metadata: { type: 'json', nullable: true },
      createdAt: { ...DATETIME, fieldName: 'created_at' },
    },
  });
}
