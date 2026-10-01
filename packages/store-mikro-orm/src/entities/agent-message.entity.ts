import type {
  AgentUiComponent,
  MessageAttachment,
  MessageFeedback,
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
  /** The persona the turn that wrote this message ran under; `null` → none. */
  persona?: string | null;
  /** The run (turn) that produced this message; `null` for a pre-rollout row. */
  runId?: string | null;
  /** The step's streamed thinking; `null` when the model produced none. */
  reasoning?: string | null;
  reasoningMs?: number | null;
  /** Components pushed during the step (`ui` stream frames), replayed on reload. */
  ui?: AgentUiComponent[] | null;
  /** The thread owner's thumbs-up/down (+ comment); `null` when unrated. Not copied on fork. */
  feedback?: MessageFeedback | null;
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
      persona: { type: 'string', nullable: true, ...str },
      runId: { type: 'string', nullable: true, fieldName: 'run_id', ...str },
      reasoning: { type: 'text', nullable: true, ...str },
      reasoningMs: { type: 'integer', nullable: true, fieldName: 'reasoning_ms' },
      ui: { type: 'json', nullable: true },
      feedback: { type: 'json', nullable: true },
      createdAt: { type: 'datetime', fieldName: 'created_at' },
    },
  });
}
