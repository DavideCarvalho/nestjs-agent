import { BigIntType, EntityRepository, EntityRepositoryType, EntitySchema } from '@mikro-orm/core';
import { LongTextType } from './column-types';

/**
 * One frame of a run's live stream (`MikroOrmTokenStreamSink`), numbered per run from 1 with no
 * gaps. `frame` is one NDJSON line; `null` marks the end, with `error` set when the run failed.
 * `createdAt` (epoch-ms) is what the TTL counts from — a run's LAST row.
 */
export class AgentStreamFrame {
  runId!: string;
  seq!: number;
  frame?: string | null;
  error?: string | null;
  /** Epoch-ms. */
  createdAt!: number;
  declare [EntityRepositoryType]?: AgentStreamFrameRepository;
}

/** Custom repository for {@link AgentStreamFrame}. */
export class AgentStreamFrameRepository extends EntityRepository<AgentStreamFrame> {}

/** Builds the `agent_stream_frame` schema. */
export function agentStreamFrameSchema(collation?: string): EntitySchema<AgentStreamFrame> {
  const str = collation !== undefined ? { collation } : {};
  return new EntitySchema<AgentStreamFrame>({
    class: AgentStreamFrame,
    tableName: 'agent_stream_frame',
    repository: () => AgentStreamFrameRepository,
    properties: {
      runId: { type: 'string', primary: true, fieldName: 'run_id', ...str },
      seq: { type: 'integer', primary: true },
      frame: { type: LongTextType, nullable: true, ...str },
      error: { type: LongTextType, nullable: true, ...str },
      createdAt: { type: new BigIntType('number'), fieldName: 'created_at' },
    },
  });
}
