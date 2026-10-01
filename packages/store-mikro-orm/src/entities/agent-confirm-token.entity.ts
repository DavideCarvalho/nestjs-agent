import { BigIntType, EntityRepository, EntityRepositoryType, EntitySchema } from '@mikro-orm/core';

/**
 * A spent confirm token (`defineConfirmedTool`), keyed by its SHA-256 — the primary key is the lock
 * that makes a confirmation single use across replicas. Only the hash, the actor and the tool are
 * kept, never an argument; past `expiresAt` the row is dead weight for `purgeExpired`.
 */
export class AgentConfirmToken {
  hash!: string;
  actorRef!: string;
  tool!: string;
  /** Epoch-ms. */
  expiresAt!: number;
  /** Epoch-ms. */
  createdAt!: number;
  declare [EntityRepositoryType]?: AgentConfirmTokenRepository;
}

/** Custom repository for {@link AgentConfirmToken}. */
export class AgentConfirmTokenRepository extends EntityRepository<AgentConfirmToken> {}

/** Builds the `agent_confirm_token` schema. */
export function agentConfirmTokenSchema(collation?: string): EntitySchema<AgentConfirmToken> {
  const str = collation !== undefined ? { collation } : {};
  return new EntitySchema<AgentConfirmToken>({
    class: AgentConfirmToken,
    tableName: 'agent_confirm_token',
    repository: () => AgentConfirmTokenRepository,
    indexes: [{ name: 'agent_confirm_token_expires_idx', properties: ['expiresAt'] }],
    properties: {
      hash: { type: 'string', primary: true, length: 64, ...str },
      actorRef: { type: 'string', fieldName: 'actor_ref', ...str },
      tool: { type: 'string', ...str },
      expiresAt: { type: new BigIntType('number'), fieldName: 'expires_at' },
      createdAt: { type: new BigIntType('number'), fieldName: 'created_at' },
    },
  });
}
