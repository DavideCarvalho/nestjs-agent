import {
  SqlTokenStreamSink,
  type SqlTokenStreamSinkOptions,
  type StreamFrameRow,
  type StreamFrameTable,
} from '@dudousxd/nestjs-agent-core';
import { type EntityManager, UniqueConstraintViolationException } from '@mikro-orm/core';

/** The table {@link import('./entities/agent-stream-frame.entity').AgentStreamFrame} maps. */
const TABLE = 'agent_stream_frame';

function toInt(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') return Number.parseInt(value, 10) || 0;
  return 0;
}

/** {@link StreamFrameTable} over `agent_stream_frame`, through a MikroORM {@link EntityManager}. */
export class MikroOrmStreamFrameTable implements StreamFrameTable {
  constructor(private readonly em: EntityManager) {}

  private get connection() {
    return this.em.fork().getConnection();
  }

  async append(
    runId: string,
    row: { frame: string | null; error: string | null; createdAt: number },
  ): Promise<void> {
    // The next number and the insert are one statement: the (run_id, seq) key settles a race.
    // MySQL takes an INSERT … SELECT from the table it inserts into (it materialises the read).
    await this.connection.execute(
      `insert into ${TABLE} (run_id, seq, frame, error, created_at) ` +
        `select ?, coalesce(max(seq), 0) + 1, ?, ?, ? from ${TABLE} where run_id = ?`,
      [runId, row.frame, row.error, row.createdAt, runId],
      'run',
    );
  }

  async read(runId: string, after: number, limit: number): Promise<StreamFrameRow[]> {
    const rows: { seq: unknown; frame: string | null; error: string | null }[] =
      await this.connection.execute(
        `select seq, frame, error from ${TABLE} where run_id = ? and seq > ? order by seq asc limit ${Math.max(1, Math.floor(limit))}`,
        [runId, after],
      );
    return rows.map((row) => ({ seq: toInt(row.seq), frame: row.frame, error: row.error }));
  }

  async has(runId: string): Promise<boolean> {
    const rows: unknown[] = await this.connection.execute(
      `select 1 as found from ${TABLE} where run_id = ? limit 1`,
      [runId],
    );
    return rows.length > 0;
  }

  async remove(runIds: readonly string[]): Promise<void> {
    if (runIds.length === 0) return;
    await this.connection.execute(
      `delete from ${TABLE} where run_id in (${runIds.map(() => '?').join(', ')})`,
      [...runIds],
      'run',
    );
  }

  async lapsedRuns(cutoff: number): Promise<string[]> {
    // Two steps (here, then `remove`) rather than one DELETE … IN (SELECT … FROM the same table),
    // which MySQL refuses.
    const rows: { run_id: string }[] = await this.connection.execute(
      `select run_id from ${TABLE} group by run_id having max(created_at) < ?`,
      [cutoff],
    );
    return rows.map((row) => String(row.run_id));
  }

  isUniqueViolation(error: unknown): boolean {
    return error instanceof UniqueConstraintViolationException;
  }
}

/**
 * A multi-replica `TokenStreamSink` over the app's MikroORM database — several replicas, no Redis.
 * Polled, with streamed text coalesced into one row per `flushMs`; see `SqlTokenStreamSink` for the
 * trade-offs. The `agent_stream_frame` table is one of the agent entities (`ensureAgentSchema` /
 * `agentSchemaSql`).
 *
 * ```ts
 * AgentModule.forRootAsync({
 *   inject: [EntityManager],
 *   useFactory: (em: EntityManager) => ({ model, sink: new MikroOrmTokenStreamSink(em) }),
 * });
 * ```
 */
export class MikroOrmTokenStreamSink extends SqlTokenStreamSink {
  constructor(em: EntityManager, options: SqlTokenStreamSinkOptions = {}) {
    super(new MikroOrmStreamFrameTable(em), options);
  }
}
