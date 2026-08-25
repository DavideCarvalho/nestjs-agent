import type {
  MessageAttachment,
  MessageRole,
  MessageUsage,
  ToolCallRequest,
  ToolResult,
} from '@dudousxd/nestjs-agent-core';
import { EntityRepository, EntityRepositoryType, EntitySchema } from '@mikro-orm/core';
import { AgentThread } from './agent-thread.entity';

/**
 * One stored message in a thread. The model-facing extras (`toolCalls`/`toolResults`/
 * `followUps`/`usage`) are folded into nullable JSON columns so a single row round-trips
 * to a {@link import('@dudousxd/nestjs-agent-core').StoredMessage}.
 */
export class AgentMessage {
  id!: string;
  thread!: AgentThread;
  role!: MessageRole;
  content!: string;
  toolCalls?: ToolCallRequest[] | null;
  toolResults?: ToolResult[] | null;
  attachments?: MessageAttachment[] | null;
  followUps?: string[] | null;
  usage?: MessageUsage | null;
  agentName?: string | null;
  createdAt!: Date;
  declare [EntityRepositoryType]?: AgentMessageRepository;
}

/** Custom repository for {@link AgentMessage}, so a host can inject it by type instead of passing the entity to every `em` call. */
export class AgentMessageRepository extends EntityRepository<AgentMessage> {}

/** Builds the `agent_message` schema. `thread` cascades on delete (§5). */
export function agentMessageSchema(collation?: string): EntitySchema<AgentMessage> {
  const str = collation !== undefined ? { collation } : {};
  return new EntitySchema<AgentMessage>({
    class: AgentMessage,
    tableName: 'agent_message',
    repository: () => AgentMessageRepository,
    indexes: [{ name: 'agent_message_thread_created_idx', properties: ['thread', 'createdAt'] }],
    properties: {
      id: { type: 'string', primary: true, ...str },
      thread: {
        kind: 'm:1',
        entity: () => AgentThread,
        deleteRule: 'cascade',
        fieldName: 'thread_id',
        ...str,
      },
      role: { type: 'string', ...str },
      content: { type: 'text', ...str },
      toolCalls: { type: 'json', nullable: true, fieldName: 'tool_calls' },
      toolResults: { type: 'json', nullable: true, fieldName: 'tool_results' },
      attachments: { type: 'json', nullable: true },
      followUps: { type: 'json', nullable: true, fieldName: 'follow_ups' },
      usage: { type: 'json', nullable: true },
      agentName: { type: 'string', nullable: true, fieldName: 'agent_name', ...str },
      createdAt: { type: 'datetime', fieldName: 'created_at' },
    },
  });
}
