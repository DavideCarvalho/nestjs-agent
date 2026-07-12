import type { ToolCallStatus, ToolKind } from '@dudousxd/nestjs-agent-core';
import { EntitySchema } from '@mikro-orm/core';
import { AgentMessage } from './agent-message.entity';

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
}

/** Builds the `agent_tool_call` schema. `message` cascades on delete (§5). */
export function agentToolCallSchema(collation?: string): EntitySchema<AgentToolCall> {
  const str = collation !== undefined ? { collation } : {};
  return new EntitySchema<AgentToolCall>({
    class: AgentToolCall,
    tableName: 'agent_tool_call',
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
      error: { type: 'text', nullable: true, ...str },
      createdAt: { type: 'datetime', fieldName: 'created_at' },
      executedAt: { type: 'datetime', nullable: true, fieldName: 'executed_at' },
      runId: { type: 'string', nullable: true, fieldName: 'run_id', ...str },
    },
  });
}
