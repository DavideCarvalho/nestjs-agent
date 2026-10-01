import type { QueuePause } from '@dudousxd/nestjs-agent-core';
import { EntityRepository, EntityRepositoryType, EntitySchema } from '@mikro-orm/core';
import { DATETIME, identityCollation } from './column-types';

/**
 * A conversation thread. `deletedAt` drives soft delete (§5): a deleted thread is
 * hidden from {@link MikroOrmAgentStore.getThread}/`listThreads` but its row survives.
 */
export class AgentThread {
  id!: string;
  actorRef!: string;
  tenantRef?: string | null;
  title!: string;
  transient!: boolean;
  activeStreamId?: string | null;
  /** The agent name a new turn on this thread defaults to when the caller names none. */
  defaultAgent?: string | null;
  /** The model every turn on this thread runs on unless the send names one; `null` → default. */
  model?: string | null;
  /** The persona a send on this thread runs under when it names none; `null` → the agent's default. */
  persona?: string | null;
  /** Why the thread's message queue stopped draining; `null` → it drains. */
  queuePause?: QueuePause | null;
  createdAt!: Date;
  updatedAt!: Date;
  deletedAt?: Date | null;
  declare [EntityRepositoryType]?: AgentThreadRepository;
}

/** Custom repository for {@link AgentThread}, so a host can inject it by type instead of passing the entity to every `em` call. */
export class AgentThreadRepository extends EntityRepository<AgentThread> {}

/** Builds the `agent_thread` schema. `collation` is applied to string columns (MySQL parity). */
export function agentThreadSchema(collation?: string): EntitySchema<AgentThread> {
  const str = collation !== undefined ? { collation } : {};
  const identity = identityCollation(collation);
  return new EntitySchema<AgentThread>({
    class: AgentThread,
    tableName: 'agent_thread',
    repository: () => AgentThreadRepository,
    indexes: [{ name: 'agent_thread_actor_updated_idx', properties: ['actorRef', 'updatedAt'] }],
    properties: {
      id: { type: 'string', primary: true, ...str },
      actorRef: { type: 'string', fieldName: 'actor_ref', ...identity },
      tenantRef: { type: 'string', nullable: true, fieldName: 'tenant_ref', ...identity },
      title: { type: 'string', ...str },
      transient: { type: 'boolean', default: false },
      activeStreamId: { type: 'string', nullable: true, fieldName: 'active_stream_id', ...str },
      defaultAgent: { type: 'string', nullable: true, fieldName: 'default_agent', ...str },
      model: { type: 'string', nullable: true, ...str },
      persona: { type: 'string', nullable: true, ...str },
      queuePause: { type: 'json', nullable: true, fieldName: 'queue_pause' },
      createdAt: { ...DATETIME, fieldName: 'created_at' },
      updatedAt: { ...DATETIME, fieldName: 'updated_at' },
      deletedAt: { ...DATETIME, nullable: true, fieldName: 'deleted_at' },
    },
  });
}
