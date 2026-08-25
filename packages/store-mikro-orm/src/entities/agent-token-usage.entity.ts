import type { UsagePurpose } from '@dudousxd/nestjs-agent-core';
import { EntityRepository, EntityRepositoryType, EntitySchema } from '@mikro-orm/core';
import { AgentThread } from './agent-thread.entity';

/** A token-usage ledger row, summed per actor per day by {@link MikroOrmAgentStore.quotaToday}. */
export class AgentTokenUsage {
  id!: string;
  thread!: AgentThread;
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
  /** Provider-reported actual USD cost for the turn; null when only tokens were reported. */
  costUsd?: number | null;
  createdAt!: Date;
  [EntityRepositoryType]?: AgentTokenUsageRepository;
}

/** Custom repository for {@link AgentTokenUsage}, so a host can inject it by type instead of passing the entity to every `em` call. */
export class AgentTokenUsageRepository extends EntityRepository<AgentTokenUsage> {}

/** Builds the `agent_token_usage` schema. `thread` cascades on delete (§5). */
export function agentTokenUsageSchema(collation?: string): EntitySchema<AgentTokenUsage> {
  const str = collation !== undefined ? { collation } : {};
  return new EntitySchema<AgentTokenUsage>({
    class: AgentTokenUsage,
    tableName: 'agent_token_usage',
    repository: () => AgentTokenUsageRepository,
    indexes: [
      { name: 'agent_token_usage_actor_created_idx', properties: ['actorRef', 'createdAt'] },
    ],
    properties: {
      id: { type: 'string', primary: true, ...str },
      thread: {
        kind: 'm:1',
        entity: () => AgentThread,
        deleteRule: 'cascade',
        fieldName: 'thread_id',
        ...str,
      },
      actorRef: { type: 'string', fieldName: 'actor_ref', ...str },
      messageId: { type: 'string', nullable: true, fieldName: 'message_id', ...str },
      modelId: { type: 'string', fieldName: 'model_id', ...str },
      purpose: { type: 'string', ...str },
      inputTokens: { type: 'integer', fieldName: 'input_tokens' },
      outputTokens: { type: 'integer', fieldName: 'output_tokens' },
      cacheWriteTokens: { type: 'integer', nullable: true, fieldName: 'cache_write_tokens' },
      cacheReadTokens: { type: 'integer', nullable: true, fieldName: 'cache_read_tokens' },
      costUsd: { type: 'float', nullable: true, fieldName: 'cost_usd' },
      createdAt: { type: 'datetime', fieldName: 'created_at' },
    },
  });
}
