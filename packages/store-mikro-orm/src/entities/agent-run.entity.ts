import { EntitySchema } from '@mikro-orm/core';
import { AgentThread } from './agent-thread.entity';

/** A run's lifecycle status. Not part of the core SPI (that surfaces `string`) — internal only. */
export type AgentRunStatus = 'running' | 'completed' | 'failed';

/**
 * One recorded run (turn) outcome — the durable half of what `aviary:agent:*` diagnostics report
 * ephemerally. Written by {@link MikroOrmAgentStore.recordRunStart}/`recordRunEnd`/`bumpRunRetries`,
 * read by {@link import('../mikro-orm-governance-queries').MikroOrmGovernanceQueries} for the
 * reliability surfaces (success rate, error breakdown, duration percentiles, trend, recent runs).
 */
export class AgentRun {
  id!: string;
  thread!: AgentThread;
  actorRef!: string;
  agentName?: string | null;
  status!: AgentRunStatus;
  durationMs?: number | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  retries!: number;
  startedAt!: Date;
  settledAt?: Date | null;
}

/** Builds the `agent_run` schema. `thread` cascades on delete (§5). */
export function agentRunSchema(collation?: string): EntitySchema<AgentRun> {
  const str = collation !== undefined ? { collation } : {};
  return new EntitySchema<AgentRun>({
    class: AgentRun,
    tableName: 'agent_run',
    indexes: [{ name: 'agent_run_started_idx', properties: ['startedAt'] }],
    properties: {
      id: { type: 'string', primary: true, ...str },
      thread: {
        kind: 'm:1',
        entity: () => AgentThread,
        deleteRule: 'cascade',
        fieldName: 'thread_id',
        ...str,
      },
      actorRef: { type: 'string', fieldName: 'actor_ref', ...str },
      agentName: { type: 'string', nullable: true, fieldName: 'agent_name', ...str },
      status: { type: 'string', ...str },
      durationMs: { type: 'integer', nullable: true, fieldName: 'duration_ms' },
      errorCode: { type: 'string', nullable: true, fieldName: 'error_code', ...str },
      errorMessage: { type: 'text', nullable: true, fieldName: 'error_message', ...str },
      retries: { type: 'integer', default: 0 },
      startedAt: { type: 'datetime', fieldName: 'started_at' },
      settledAt: { type: 'datetime', nullable: true, fieldName: 'settled_at' },
    },
  });
}
