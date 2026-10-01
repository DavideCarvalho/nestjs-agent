import {
  SqlTokenStreamSink,
  type SqlTokenStreamSinkOptions,
  type StreamFrameRow,
  type StreamFrameTable,
} from '@dudousxd/nestjs-agent-core';
import { and, asc, eq, gt, inArray, lt, max, sql } from 'drizzle-orm';
import {
  type AgentDialect,
  type AgentDrizzleDb,
  type AgentSqliteDb,
  type AgentTables,
  agentDialectOf,
  agentTablesFor,
  asBuilder,
  isUniqueViolation,
  runSql,
} from './dialect.js';
import { agentStreamFrame } from './schema.js';

/** {@link StreamFrameTable} over `agent_stream_frame`, through a Drizzle handle on any dialect. */
export class DrizzleStreamFrameTable implements StreamFrameTable {
  private readonly db: AgentSqliteDb;
  private readonly dialect: AgentDialect;
  private readonly t: AgentTables;

  constructor(db: AgentDrizzleDb) {
    this.dialect = agentDialectOf(db);
    this.t = agentTablesFor(this.dialect);
    this.db = asBuilder(db);
  }

  async append(
    runId: string,
    row: { frame: string | null; error: string | null; createdAt: number },
  ): Promise<void> {
    // The next number and the insert are one statement: the (run_id, seq) key settles a race.
    // MySQL takes an INSERT … SELECT from the table it inserts into (it materialises the read).
    await runSql(
      this.db,
      this.dialect,
      sql`INSERT INTO agent_stream_frame (run_id, seq, frame, error, created_at)
          SELECT ${runId}, COALESCE(MAX(seq), 0) + 1, ${row.frame}, ${row.error}, ${row.createdAt}
          FROM agent_stream_frame WHERE run_id = ${runId}`,
    );
  }

  async read(runId: string, after: number, limit: number): Promise<StreamFrameRow[]> {
    return this.db
      .select({
        seq: this.t.agentStreamFrame.seq,
        frame: this.t.agentStreamFrame.frame,
        error: this.t.agentStreamFrame.error,
      })
      .from(this.t.agentStreamFrame)
      .where(and(eq(this.t.agentStreamFrame.runId, runId), gt(this.t.agentStreamFrame.seq, after)))
      .orderBy(asc(this.t.agentStreamFrame.seq))
      .limit(limit);
  }

  async has(runId: string): Promise<boolean> {
    const rows = await this.db
      .select({ seq: this.t.agentStreamFrame.seq })
      .from(this.t.agentStreamFrame)
      .where(eq(this.t.agentStreamFrame.runId, runId))
      .limit(1);
    return rows.length > 0;
  }

  async remove(runIds: readonly string[]): Promise<void> {
    if (runIds.length === 0) return;
    await this.db
      .delete(this.t.agentStreamFrame)
      .where(inArray(this.t.agentStreamFrame.runId, [...runIds]));
  }

  async lapsedRuns(cutoff: number): Promise<string[]> {
    const rows = await this.db
      .select({ runId: this.t.agentStreamFrame.runId })
      .from(this.t.agentStreamFrame)
      .groupBy(this.t.agentStreamFrame.runId)
      .having(lt(max(this.t.agentStreamFrame.createdAt), cutoff));
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
