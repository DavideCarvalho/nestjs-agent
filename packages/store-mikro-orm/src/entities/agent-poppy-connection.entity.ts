import { BigIntType, EntityRepository, EntityRepositoryType, EntitySchema } from '@mikro-orm/core';
import { LongTextType, identityCollation } from './column-types';

/**
 * One of this app's Poppy connections (`MikroOrmPoppyConnectionStore`): per (owner, Company
 * issuer), holding the client state SEALED by the caller — never a token in the clear. The issuer
 * is at most 512 characters: with the owner it is the primary key, and MySQL caps an index at 3072
 * bytes.
 *
 * @experimental Personal Agent Protocol Draft 0.1.
 */
export class AgentPoppyConnection {
  owner!: string;
  issuer!: string;
  domain!: string;
  organization!: string;
  scope!: string;
  status!: string;
  /** Sealed client state. */
  state!: string;
  /** Epoch-ms. */
  createdAt!: number;
  /** Epoch-ms. */
  updatedAt!: number;
  declare [EntityRepositoryType]?: AgentPoppyConnectionRepository;
}

/** Custom repository for {@link AgentPoppyConnection}. */
export class AgentPoppyConnectionRepository extends EntityRepository<AgentPoppyConnection> {}

/** Builds the `agent_poppy_connection` schema. */
export function agentPoppyConnectionSchema(collation?: string): EntitySchema<AgentPoppyConnection> {
  const str = collation !== undefined ? { collation } : {};
  const identity = identityCollation(collation);
  return new EntitySchema<AgentPoppyConnection>({
    class: AgentPoppyConnection,
    tableName: 'agent_poppy_connection',
    repository: () => AgentPoppyConnectionRepository,
    properties: {
      owner: { type: 'string', primary: true, length: 255, ...identity },
      issuer: { type: 'string', primary: true, length: 512, ...identity },
      domain: { type: 'string', ...str },
      organization: { type: 'string', ...str },
      scope: { type: LongTextType, ...str },
      status: { type: 'string', length: 16, ...str },
      state: { type: LongTextType, ...identity },
      createdAt: { type: new BigIntType('number'), fieldName: 'created_at' },
      updatedAt: { type: new BigIntType('number'), fieldName: 'updated_at' },
    },
  });
}
