import type {
  PoppyConnectionRecord,
  PoppyConnectionStore,
  PoppyPendingConnect,
} from '@dudousxd/nestjs-agent-core';
import { and, asc, eq } from 'drizzle-orm';
import {
  type AgentDialect,
  type AgentDrizzleDb,
  type AgentSqliteDb,
  type AgentTables,
  agentDialectOf,
  agentTablesFor,
  asBuilder,
  upsert,
} from './dialect.js';

/** The slice of Drizzle's MySQL insert builder used here, which the SQLite view does not have. */
interface MySqlInsertIgnore<Row> {
  ignore(): { values(value: Row): PromiseLike<unknown> };
}

const nullable = (value: unknown): string | null => (value == null ? null : String(value));
const toInt = (value: unknown): number => (typeof value === 'number' ? value : Number(value ?? 0));

/**
 * A `PoppyConnectionStore` (`AgentPoppyConnectionsModule`: this app's agent acting at other Poppy
 * companies) over the `agent_poppy_connection` and `agent_poppy_connect` tables. A connection is
 * keyed by (owner, issuer) and upserted on it; a pending connect is inserted once, skipping a
 * duplicate id. The client state arrives sealed: no token is ever stored in the clear. On MySQL an
 * issuer is at most 512 characters (the composite key's index limit). The tables come from
 * `ensureAgentSchema` (or your own migration).
 *
 * @experimental Tracks Personal Agent Protocol Draft 0.1 (https://personalagentprotocol.org/docs/spec).
 */
export class DrizzlePoppyConnectionStore implements PoppyConnectionStore {
  private readonly db: AgentSqliteDb;
  private readonly dialect: AgentDialect;
  private readonly t: AgentTables;

  constructor(db: AgentDrizzleDb) {
    this.dialect = agentDialectOf(db);
    this.t = agentTablesFor(this.dialect);
    this.db = asBuilder(db);
  }

  async listConnections(owner: string): Promise<PoppyConnectionRecord[]> {
    const table = this.t.agentPoppyConnection;
    const rows = await this.db
      .select()
      .from(table)
      .where(eq(table.owner, owner))
      .orderBy(asc(table.domain), asc(table.issuer));
    return rows.map(toConnection);
  }

  async getConnection(owner: string, issuer: string): Promise<PoppyConnectionRecord | null> {
    const table = this.t.agentPoppyConnection;
    const [row] = await this.db
      .select()
      .from(table)
      .where(and(eq(table.owner, owner), eq(table.issuer, issuer)))
      .limit(1);
    return row ? toConnection(row) : null;
  }

  async saveConnection(record: PoppyConnectionRecord): Promise<void> {
    const table = this.t.agentPoppyConnection;
    const columns = {
      domain: record.domain,
      organization: record.organization,
      scope: record.scope,
      status: record.status,
      state: record.state,
      updatedAt: record.updatedAt,
    };
    await upsert(
      this.dialect,
      this.db.insert(table).values({
        owner: record.owner,
        issuer: record.issuer,
        createdAt: record.createdAt,
        ...columns,
      }),
      [table.owner, table.issuer],
      columns,
    );
  }

  async deleteConnection(owner: string, issuer: string): Promise<void> {
    const table = this.t.agentPoppyConnection;
    await this.db.delete(table).where(and(eq(table.owner, owner), eq(table.issuer, issuer)));
  }

  async createPending(record: PoppyPendingConnect): Promise<void> {
    const table = this.t.agentPoppyConnect;
    const row = {
      id: record.id,
      owner: record.owner,
      domain: record.domain,
      issuer: record.issuer,
      organization: record.organization,
      scope: record.scope,
      actor: record.actor === null ? null : JSON.stringify(record.actor),
      threadId: record.threadId,
      runId: record.runId,
      toolCallId: record.toolCallId,
      flow: record.flow,
      status: record.status,
      expiresAt: record.expiresAt,
      createdAt: record.createdAt,
    };
    // Created once: a second create of the same id is a no-op.
    if (this.dialect === 'mysql') {
      const insert = this.db.insert(table) as unknown as MySqlInsertIgnore<typeof row>;
      await insert.ignore().values(row);
      return;
    }
    await this.db.insert(table).values(row).onConflictDoNothing();
  }

  async getPending(id: string): Promise<PoppyPendingConnect | null> {
    const table = this.t.agentPoppyConnect;
    const [row] = await this.db.select().from(table).where(eq(table.id, id)).limit(1);
    if (!row) return null;
    return {
      id: row.id,
      owner: row.owner,
      domain: row.domain,
      issuer: row.issuer,
      organization: row.organization,
      scope: row.scope ?? '',
      actor: row.actor == null ? null : (JSON.parse(row.actor) as PoppyPendingConnect['actor']),
      threadId: nullable(row.threadId),
      runId: nullable(row.runId),
      toolCallId: nullable(row.toolCallId),
      flow: nullable(row.flow),
      status: row.status as PoppyPendingConnect['status'],
      expiresAt: toInt(row.expiresAt),
      createdAt: toInt(row.createdAt),
    };
  }

  async updatePending(
    id: string,
    patch: Partial<Pick<PoppyPendingConnect, 'flow' | 'status'>>,
  ): Promise<void> {
    const set: { flow?: string | null; status?: string } = {};
    if (patch.flow !== undefined) set.flow = patch.flow;
    if (patch.status !== undefined) set.status = patch.status;
    if (Object.keys(set).length === 0) return;
    const table = this.t.agentPoppyConnect;
    await this.db.update(table).set(set).where(eq(table.id, id));
  }
}

function toConnection(
  row: AgentTables['agentPoppyConnection']['$inferSelect'],
): PoppyConnectionRecord {
  return {
    owner: row.owner,
    issuer: row.issuer,
    domain: row.domain,
    organization: row.organization,
    scope: row.scope ?? '',
    status: row.status as PoppyConnectionRecord['status'],
    state: row.state,
    createdAt: toInt(row.createdAt),
    updatedAt: toInt(row.updatedAt),
  };
}
