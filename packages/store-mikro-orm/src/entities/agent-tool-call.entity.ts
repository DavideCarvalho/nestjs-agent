import type { ToolCallStatus, ToolConfirmation, ToolKind } from '@dudousxd/nestjs-agent-core';
import { EntityRepository, EntityRepositoryType, EntitySchema } from '@mikro-orm/core';
import { AgentMessage } from './agent-message.entity';
import { DATETIME, LongTextType } from './column-types';

/** A tool call requested during an assistant turn. The pk is the model-supplied `toolCallId`. */
export class AgentToolCall {
  id!: string;
  message!: AgentMessage;
  toolName!: string;
  toolType!: ToolKind;
  input?: unknown;
  output?: unknown;
  status!: ToolCallStatus;
  executedByRef?: string | null;
  executionMs?: number | null;
  error?: string | null;
  createdAt!: Date;
  executedAt?: Date | null;
  /** The run (turn) this call belongs to, for a trace deep-link; `null` for a pre-rollout row. */
  runId?: string | null;
  /** Who had to approve it (`requester` or a role); `null` for a call no policy put to anyone. */
  approver?: string | null;
  /** Resolved per-call confirmation; null falls back to presentation templates. */
  confirmation?: ToolConfirmation | null;
  /** When the approval request lapses; `null` → never. */
  expiresAt?: Date | null;
  /** The approval covers later calls of this tool in this thread. */
  remember?: boolean | null;
  /** The surface the decision came through (`web`, `slack`, `remembered`, …). */
  decidedVia?: string | null;
  declare [EntityRepositoryType]?: AgentToolCallRepository;
}

/** Custom repository for {@link AgentToolCall}, so a host can inject it by type instead of passing the entity to every `em` call. */
export class AgentToolCallRepository extends EntityRepository<AgentToolCall> {}

/** Builds the `agent_tool_call` schema. `message` cascades on delete (§5). */
export function agentToolCallSchema(collation?: string): EntitySchema<AgentToolCall> {
  const str = collation !== undefined ? { collation } : {};
  return new EntitySchema<AgentToolCall>({
    class: AgentToolCall,
    tableName: 'agent_tool_call',
    repository: () => AgentToolCallRepository,
    // Declared, not left to the ORM: MikroORM indexes a many-to-one for you on MySQL and SQLite but
    // NOT on Postgres, where every message-scoped read here (the turn reader's IN (…), the approval
    // read, `truncateFrom`'s delete, the cascade from agent_message) then scanned the whole table.
    // Unnamed, so it takes the name the ORM already gave its own index elsewhere — a MySQL or SQLite
    // schema sees the index it has, and only Postgres gains one.
    indexes: [{ properties: ['message'] }],
    properties: {
      id: { type: 'string', primary: true, ...str },
      message: {
        kind: 'm:1',
        entity: () => AgentMessage,
        deleteRule: 'cascade',
        fieldName: 'message_id',
        ...str,
      },
      toolName: { type: 'string', fieldName: 'tool_name', ...str },
      toolType: { type: 'string', fieldName: 'tool_type', ...str },
      input: { type: 'json', nullable: true },
      output: { type: 'json', nullable: true },
      status: { type: 'string', ...str },
      executedByRef: { type: 'string', nullable: true, fieldName: 'executed_by_ref', ...str },
      executionMs: { type: 'integer', nullable: true, fieldName: 'execution_ms' },
      error: { type: LongTextType, nullable: true, ...str },
      createdAt: { ...DATETIME, fieldName: 'created_at' },
      executedAt: { ...DATETIME, nullable: true, fieldName: 'executed_at' },
      runId: { type: 'string', nullable: true, fieldName: 'run_id', ...str },
      confirmation: { type: 'json', nullable: true },
      approver: { type: 'string', nullable: true, ...str },
      expiresAt: { ...DATETIME, nullable: true, fieldName: 'expires_at' },
      remember: { type: 'boolean', nullable: true },
      decidedVia: { type: 'string', nullable: true, fieldName: 'decided_via', ...str },
    },
  });
}
