import type {
  CostSource,
  GenuiErrorCategory,
  GenuiToolMarker,
  GenuiValidity,
} from '@dudousxd/nestjs-agent-core';
import { BigIntType, EntityRepository, EntityRepositoryType, EntitySchema } from '@mikro-orm/core';
import { AgentThread } from './agent-thread.entity';
import { LongTextType, identityCollation } from './column-types';

/**
 * Generative-UI telemetry (`AgentStore.recordGenuiCalls`): one row per UI tool call, keyed by the
 * tool call's id, so a replayed record replaces rather than duplicates. Metadata only — `payload`
 * (the call's arguments) is filled solely when the tool samples payloads.
 */
export class AgentGenuiCall {
  /** The tool call's id. */
  id!: string;
  runId!: string;
  thread!: AgentThread;
  actorRef!: string;
  agentName?: string | null;
  step!: number;
  toolName!: string;
  channel!: string;
  mode!: GenuiToolMarker['mode'];
  modelId!: string;
  attempt!: number;
  outcome!: 'ok' | 'error';
  validity!: GenuiValidity;
  errorCategory?: GenuiErrorCategory | null;
  errorMessage?: string | null;
  inputTokens!: number;
  outputTokens!: number;
  costUsd?: number | null;
  costSource?: CostSource | null;
  firstFrameMs?: number | null;
  completeFrameMs?: number | null;
  payloadBytes!: number;
  payload?: string | null;
  /** Epoch-ms. */
  createdAt!: number;
  declare [EntityRepositoryType]?: AgentGenuiCallRepository;
}

/** Custom repository for {@link AgentGenuiCall}. */
export class AgentGenuiCallRepository extends EntityRepository<AgentGenuiCall> {}

/** Builds the `agent_genui_call` schema. `thread` cascades on delete, like `agent_token_usage`. */
export function agentGenuiCallSchema(collation?: string): EntitySchema<AgentGenuiCall> {
  const str = collation !== undefined ? { collation } : {};
  const identity = identityCollation(collation);
  return new EntitySchema<AgentGenuiCall>({
    class: AgentGenuiCall,
    tableName: 'agent_genui_call',
    repository: () => AgentGenuiCallRepository,
    indexes: [
      { name: 'agent_genui_call_created_idx', properties: ['createdAt'] },
      { name: 'agent_genui_call_run_idx', properties: ['runId'] },
    ],
    properties: {
      id: { type: 'string', primary: true, ...identity },
      runId: { type: 'string', fieldName: 'run_id', ...identity },
      thread: {
        kind: 'm:1',
        entity: () => AgentThread,
        deleteRule: 'cascade',
        fieldName: 'thread_id',
        ...str,
      },
      actorRef: { type: 'string', fieldName: 'actor_ref', ...identity },
      agentName: { type: 'string', nullable: true, fieldName: 'agent_name', ...str },
      step: { type: 'integer' },
      toolName: { type: 'string', fieldName: 'tool_name', ...str },
      channel: { type: 'string', ...str },
      mode: { type: 'string', ...str },
      modelId: { type: 'string', fieldName: 'model_id', ...str },
      attempt: { type: 'integer' },
      outcome: { type: 'string', ...str },
      validity: { type: 'string', ...str },
      errorCategory: { type: 'string', nullable: true, fieldName: 'error_category', ...str },
      errorMessage: { type: 'text', nullable: true, fieldName: 'error_message', ...str },
      inputTokens: { type: 'integer', fieldName: 'input_tokens' },
      outputTokens: { type: 'integer', fieldName: 'output_tokens' },
      costUsd: { type: 'double', nullable: true, fieldName: 'cost_usd' },
      costSource: { type: 'string', length: 16, nullable: true, fieldName: 'cost_source', ...str },
      firstFrameMs: { type: new BigIntType('number'), nullable: true, fieldName: 'first_frame_ms' },
      completeFrameMs: {
        type: new BigIntType('number'),
        nullable: true,
        fieldName: 'complete_frame_ms',
      },
      payloadBytes: { type: 'integer', fieldName: 'payload_bytes' },
      payload: { type: LongTextType, nullable: true, ...str },
      createdAt: { type: new BigIntType('number'), fieldName: 'created_at' },
    },
  });
}
