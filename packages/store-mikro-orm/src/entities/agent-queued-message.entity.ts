import type { Actor, MessageAttachment, PageContext } from '@dudousxd/nestjs-agent-core';
import { EntityRepository, EntityRepositoryType, EntitySchema } from '@mikro-orm/core';
import { AgentThread } from './agent-thread.entity';

/**
 * A message sent while a turn was running on its thread, waiting to run after it — see the core
 * `ChatQueueStore`. Not part of the transcript: the turn it starts appends it as its user message,
 * and the row is deleted as it starts. `position` orders a thread's queue (head first); it is
 * rewritten on a move and only ever compared within one thread.
 */
export class AgentQueuedMessage {
  id!: string;
  thread!: AgentThread;
  /** Who queued it — the turn it starts runs as this actor. */
  actor!: Actor;
  content!: string;
  attachments?: MessageAttachment[] | null;
  agentName?: string | null;
  /** The persona the send resolved — what the message starts under. */
  persona?: string | null;
  model?: string | null;
  pageContext?: PageContext | null;
  interrupt!: boolean;
  position!: number;
  createdAt!: Date;
  updatedAt!: Date;
  declare [EntityRepositoryType]?: AgentQueuedMessageRepository;
}

/** Custom repository for {@link AgentQueuedMessage}. */
export class AgentQueuedMessageRepository extends EntityRepository<AgentQueuedMessage> {}

/** Builds the `agent_queued_message` schema. `thread` cascades on delete (§5). */
export function agentQueuedMessageSchema(collation?: string): EntitySchema<AgentQueuedMessage> {
  const str = collation !== undefined ? { collation } : {};
  return new EntitySchema<AgentQueuedMessage>({
    class: AgentQueuedMessage,
    tableName: 'agent_queued_message',
    repository: () => AgentQueuedMessageRepository,
    indexes: [
      { name: 'agent_queued_message_thread_position_idx', properties: ['thread', 'position'] },
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
      actor: { type: 'json' },
      content: { type: 'text', ...str },
      attachments: { type: 'json', nullable: true },
      agentName: { type: 'string', nullable: true, fieldName: 'agent_name', ...str },
      persona: { type: 'string', nullable: true, ...str },
      model: { type: 'string', nullable: true, ...str },
      pageContext: { type: 'json', nullable: true, fieldName: 'page_context' },
      interrupt: { type: 'boolean', default: false },
      position: { type: 'integer' },
      createdAt: { type: 'datetime', fieldName: 'created_at' },
      updatedAt: { type: 'datetime', fieldName: 'updated_at' },
    },
  });
}
