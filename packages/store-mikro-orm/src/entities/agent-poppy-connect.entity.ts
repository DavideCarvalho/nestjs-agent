import { BigIntType, EntityRepository, EntityRepositoryType, EntitySchema } from '@mikro-orm/core';
import { LongTextType, identityCollation } from './column-types';

/**
 * A Poppy sign-in in flight, started by the `connect` tool and completed on this app's connect page.
 * `actor` is JSON text; `flow` the sealed per-method state.
 *
 * @experimental Personal Agent Protocol Draft 0.1.
 */
export class AgentPoppyConnect {
  id!: string;
  owner!: string;
  domain!: string;
  issuer!: string;
  organization!: string;
  scope!: string;
  /** JSON. */
  actor!: string | null;
  threadId!: string | null;
  runId!: string | null;
  toolCallId!: string | null;
  flow!: string | null;
  status!: string;
  /** Epoch-ms. */
  expiresAt!: number;
  /** Epoch-ms. */
  createdAt!: number;
  declare [EntityRepositoryType]?: AgentPoppyConnectRepository;
}

/** Custom repository for {@link AgentPoppyConnect}. */
export class AgentPoppyConnectRepository extends EntityRepository<AgentPoppyConnect> {}

/** Builds the `agent_poppy_connect` schema. */
export function agentPoppyConnectSchema(collation?: string): EntitySchema<AgentPoppyConnect> {
  const str = collation !== undefined ? { collation } : {};
  const identity = identityCollation(collation);
  return new EntitySchema<AgentPoppyConnect>({
    class: AgentPoppyConnect,
    tableName: 'agent_poppy_connect',
    repository: () => AgentPoppyConnectRepository,
    properties: {
      id: { type: 'string', primary: true, length: 64, ...identity },
      owner: { type: 'string', ...identity },
      domain: { type: 'string', ...str },
      issuer: { type: 'string', length: 512, ...identity },
      organization: { type: 'string', ...str },
      scope: { type: LongTextType, ...str },
      actor: { type: LongTextType, nullable: true, ...str },
      threadId: { type: 'string', fieldName: 'thread_id', nullable: true, ...identity },
      runId: { type: 'string', fieldName: 'run_id', nullable: true, ...identity },
      toolCallId: { type: 'string', fieldName: 'tool_call_id', nullable: true, ...identity },
      flow: { type: LongTextType, nullable: true, ...identity },
      status: { type: 'string', length: 16, ...str },
      expiresAt: { type: new BigIntType('number'), fieldName: 'expires_at' },
      createdAt: { type: new BigIntType('number'), fieldName: 'created_at' },
    },
  });
}
