import { EntitySchema } from '@mikro-orm/core';

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
  createdAt!: Date;
  updatedAt!: Date;
  deletedAt?: Date | null;
}

/** Builds the `agent_thread` schema. `collation` is applied to string columns (MySQL parity). */
export function agentThreadSchema(collation?: string): EntitySchema<AgentThread> {
  const str = collation !== undefined ? { collation } : {};
  return new EntitySchema<AgentThread>({
    class: AgentThread,
    tableName: 'agent_thread',
    indexes: [{ name: 'agent_thread_actor_updated_idx', properties: ['actorRef', 'updatedAt'] }],
    properties: {
      id: { type: 'string', primary: true, ...str },
      actorRef: { type: 'string', fieldName: 'actor_ref', ...str },
      tenantRef: { type: 'string', nullable: true, fieldName: 'tenant_ref', ...str },
      title: { type: 'string', ...str },
      transient: { type: 'boolean', default: false },
      activeStreamId: { type: 'string', nullable: true, fieldName: 'active_stream_id', ...str },
      createdAt: { type: 'datetime', fieldName: 'created_at' },
      updatedAt: { type: 'datetime', fieldName: 'updated_at' },
      deletedAt: { type: 'datetime', nullable: true, fieldName: 'deleted_at' },
    },
  });
}
