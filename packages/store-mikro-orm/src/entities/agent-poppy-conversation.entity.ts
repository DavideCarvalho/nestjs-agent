import { BigIntType, EntityRepository, EntityRepositoryType, EntitySchema } from '@mikro-orm/core';
import { LongTextType, identityCollation } from './column-types';

/**
 * A Personal Agent Protocol (Poppy) conversation (`MikroOrmPoppyStore`): who it is with, its status,
 * the User's context and the identity its turns run as (JSON text), and the reader lease
 * (`readerHolder` until `readerUntil`, epoch-ms) that lets one replica at a time write a reply.
 * Events at or below `prunedSeq` were pruned.
 *
 * @experimental Personal Agent Protocol Draft 0.1.
 */
export class AgentPoppyConversation {
  id!: string;
  clientId!: string;
  userId!: string;
  accountRef!: string | null;
  agentName!: string;
  threadId!: string | null;
  parentId!: string | null;
  openDirectId!: string | null;
  status!: string;
  responder!: string;
  /** JSON. */
  context!: string | null;
  activeRunId!: string | null;
  turnSeq!: number;
  /** JSON. */
  grantInfo!: string | null;
  readerHolder!: string | null;
  /** Epoch-ms. */
  readerUntil!: number | null;
  prunedSeq!: number;
  /** Epoch-ms. */
  createdAt!: number;
  /** Epoch-ms. */
  updatedAt!: number;
  declare [EntityRepositoryType]?: AgentPoppyConversationRepository;
}

/** Custom repository for {@link AgentPoppyConversation}. */
export class AgentPoppyConversationRepository extends EntityRepository<AgentPoppyConversation> {}

/** Builds the `agent_poppy_conversation` schema. */
export function agentPoppyConversationSchema(
  collation?: string,
): EntitySchema<AgentPoppyConversation> {
  const str = collation !== undefined ? { collation } : {};
  // Ids and the lease holder are compared exactly, on every dialect.
  const identity = identityCollation(collation);
  const bigint = () => new BigIntType('number');
  return new EntitySchema<AgentPoppyConversation>({
    class: AgentPoppyConversation,
    tableName: 'agent_poppy_conversation',
    repository: () => AgentPoppyConversationRepository,
    properties: {
      id: { type: 'string', primary: true, length: 255, ...identity },
      clientId: { type: 'string', fieldName: 'client_id', length: 2048, ...identity },
      userId: { type: 'string', fieldName: 'user_id', ...identity },
      accountRef: { type: 'string', fieldName: 'account_ref', nullable: true, ...identity },
      agentName: { type: 'string', fieldName: 'agent_name', ...str },
      threadId: { type: 'string', fieldName: 'thread_id', nullable: true, ...identity },
      parentId: { type: 'string', fieldName: 'parent_id', nullable: true, ...identity },
      openDirectId: { type: 'string', fieldName: 'open_direct_id', nullable: true, ...identity },
      status: { type: 'string', length: 16, ...str },
      responder: { type: 'string', length: 16, ...str },
      context: { type: LongTextType, nullable: true, ...str },
      activeRunId: { type: 'string', fieldName: 'active_run_id', nullable: true, ...identity },
      turnSeq: { type: bigint(), fieldName: 'turn_seq' },
      grantInfo: { type: LongTextType, fieldName: 'grant_info', nullable: true, ...str },
      readerHolder: { type: 'string', fieldName: 'reader_holder', nullable: true, ...identity },
      readerUntil: { type: bigint(), fieldName: 'reader_until', nullable: true },
      prunedSeq: { type: bigint(), fieldName: 'pruned_seq' },
      createdAt: { type: bigint(), fieldName: 'created_at' },
      updatedAt: { type: bigint(), fieldName: 'updated_at' },
    },
  });
}
