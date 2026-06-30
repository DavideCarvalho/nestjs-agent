import type { UsagePurpose } from '@dudousxd/nestjs-agent-core';
import { EntitySchema } from '@mikro-orm/core';
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
  createdAt!: Date;
}

/** Builds the `agent_token_usage` schema. `thread` cascades on delete (§5). */
export function agentTokenUsageSchema(collation?: string): EntitySchema<AgentTokenUsage> {
  const str = collation !== undefined ? { collation } : {};
  return new EntitySchema<AgentTokenUsage>({
    class: AgentTokenUsage,
    tableName: 'agent_token_usage',
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
      createdAt: { type: 'datetime', fieldName: 'created_at' },
    },
  });
}
