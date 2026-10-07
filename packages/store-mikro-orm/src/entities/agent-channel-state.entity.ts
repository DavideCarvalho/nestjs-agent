import { BigIntType, EntityRepository, EntityRepositoryType, EntitySchema } from '@mikro-orm/core';
import { LongTextType, identityCollation } from './column-types';

/**
 * Text channels' short-lived state (`@dudousxd/nestjs-agent-channels`), one row per key: the provider
 * message ids already answered, a question waiting for the person's answer, an outcome already
 * relayed. The primary key is the lock a claim takes; past `expiresAt` the row is free again and
 * dead weight for `purgeExpired`. Keys longer than 255 characters are stored by their SHA-256.
 */
export class AgentChannelState {
  key!: string;
  value!: string | null;
  /** Epoch-ms. */
  expiresAt!: number;
  /** Epoch-ms. */
  createdAt!: number;
  declare [EntityRepositoryType]?: AgentChannelStateRepository;
}

/** Custom repository for {@link AgentChannelState}. */
export class AgentChannelStateRepository extends EntityRepository<AgentChannelState> {}

/** Builds the `agent_channel_state` schema. */
export function agentChannelStateSchema(collation?: string): EntitySchema<AgentChannelState> {
  // Provider message ids are case-sensitive: compared exactly on every dialect.
  const identity = identityCollation(collation);
  return new EntitySchema<AgentChannelState>({
    class: AgentChannelState,
    tableName: 'agent_channel_state',
    repository: () => AgentChannelStateRepository,
    indexes: [{ name: 'agent_channel_state_expires_idx', properties: ['expiresAt'] }],
    properties: {
      key: { type: 'string', primary: true, length: 255, ...identity },
      value: { type: LongTextType, nullable: true },
      expiresAt: { type: new BigIntType('number'), fieldName: 'expires_at' },
      createdAt: { type: new BigIntType('number'), fieldName: 'created_at' },
    },
  });
}
