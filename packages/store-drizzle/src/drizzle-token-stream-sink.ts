import {
  SqlTokenStreamSink,
  type SqlTokenStreamSinkOptions,
  type StreamFrameRow,
  type StreamFrameTable,
} from '@dudousxd/nestjs-agent-core';
import { and, asc, eq, gt, inArray, lt, max, sql } from 'drizzle-orm';
import { type AgentDrizzleDb, agentStreamFrame } from './schema.js';

/** Did this insert lose the race for a `(run_id, seq)`? SQLite's own constraint code, nothing else. */
function isUniqueViolation(error: unknown): boolean {
  for (let current = error; current !== null && typeof current === 'object'; ) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT')) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** {@link StreamFrameTable} over `agent_stream_frame`, through a Drizzle SQLite handle. */
export class DrizzleStreamFrameTable implements StreamFrameTable {
  constructor(private readonly db: AgentDrizzleDb) {}

  async append(
    runId: string,
    row: { frame: string | null; error: string | null; createdAt: number },
  ): Promise<void> {
    // The next number and the insert are one statement: the (run_id, seq) key settles a race.
    await this.db.run(
      sql`INSERT INTO agent_stream_frame (run_id, seq, frame, error, created_at)
          SELECT ${runId}, COALESCE(MAX(seq), 0) + 1, ${row.frame}, ${row.error}, ${row.createdAt}
          FROM agent_stream_frame WHERE run_id = ${runId}`,
    );
  }

  async read(runId: string, after: number, limit: number): Promise<StreamFrameRow[]> {
    return this.db
      .select({
        seq: agentStreamFrame.seq,
        frame: agentStreamFrame.frame,
        error: agentStreamFrame.error,
      })
      .from(agentStreamFrame)
      .where(and(eq(agentStreamFrame.runId, runId), gt(agentStreamFrame.seq, after)))
      .orderBy(asc(agentStreamFrame.seq))
      .limit(limit);
  }

  async has(runId: string): Promise<boolean> {
    const rows = await this.db
      .select({ seq: agentStreamFrame.seq })
      .from(agentStreamFrame)
      .where(eq(agentStreamFrame.runId, runId))
      .limit(1);
    return rows.length > 0;
  }

  async remove(runIds: readonly string[]): Promise<void> {
    if (runIds.length === 0) return;
    await this.db.delete(agentStreamFrame).where(inArray(agentStreamFrame.runId, [...runIds]));
  }

  async lapsedRuns(cutoff: number): Promise<string[]> {
    const rows = await this.db
      .select({ runId: agentStreamFrame.runId })
      .from(agentStreamFrame)
      .groupBy(agentStreamFrame.runId)
      .having(lt(max(agentStreamFrame.createdAt), cutoff));
    return rows.map((row) => row.runId);
  }

  isUniqueViolation(error: unknown): boolean {
    return isUniqueViolation(error);
  }
}

/**
 * A multi-replica `TokenStreamSink` over the app's Drizzle database — several replicas, no Redis.
 * Polled, with streamed text coalesced into one row per `flushMs`; see `SqlTokenStreamSink` for the
 * trade-offs. The `agent_stream_frame` table comes from `ensureAgentSchema` (or your migration).
 *
 * ```ts
 * AgentModule.forRoot({ model, sink: new DrizzleTokenStreamSink(db) });
 * ```
 */
export class DrizzleTokenStreamSink extends SqlTokenStreamSink {
  constructor(db: AgentDrizzleDb, options: SqlTokenStreamSinkOptions = {}) {
    super(new DrizzleStreamFrameTable(db), options);
  }
}
