import {
  POPPY_CONNECTION_TABLES,
  type PoppyConnectionRecord,
  type PoppyConnectionStore,
  type PoppyPendingConnect,
} from '@dudousxd/nestjs-agent-core';
import type { EntityManager } from '@mikro-orm/core';

const nullable = (value: unknown): string | null => (value == null ? null : String(value));
const toInt = (value: unknown): number => (typeof value === 'number' ? value : Number(value ?? 0));

const T = POPPY_CONNECTION_TABLES.connections;
const P = POPPY_CONNECTION_TABLES.pending;

/**
 * A `PoppyConnectionStore` (`AgentPoppyConnectionsModule`: this app's agent acting at other Poppy
 * companies) over the `agent_poppy_connection` and `agent_poppy_connect` tables. A POJO receiving
 * an {@link EntityManager}; each operation runs on a fresh `em.fork()`. A connection is keyed by
 * (owner, issuer) and upserted on it; a pending connect is inserted once, skipping a duplicate id.
 * The client state arrives sealed: no token is ever stored in the clear. An issuer is at most 512
 * characters.
 *
 * @experimental Tracks Personal Agent Protocol Draft 0.1 (https://personalagentprotocol.org/docs/spec).
 */
export class MikroOrmPoppyConnectionStore implements PoppyConnectionStore {
  constructor(private readonly em: EntityManager) {}

  private get mysql(): boolean {
    const platform = this.em.getPlatform().constructor.name.toLowerCase();
    return platform.includes('mysql') || platform.includes('maria');
  }

  /** `sql` with `"identifiers"` quoted for the platform — `owner`, `state`, `status`… */
  private execute(statement: string, params: unknown[], method: 'run' | 'all' = 'run') {
    const sql = this.mysql ? statement.replaceAll('"', '`') : statement;
    return this.em.fork().getConnection().execute(sql, params, method);
  }

  private async rows(statement: string, params: unknown[]): Promise<Record<string, unknown>[]> {
    return (await this.execute(statement, params, 'all')) as Record<string, unknown>[];
  }

  async listConnections(owner: string): Promise<PoppyConnectionRecord[]> {
    const rows = await this.rows(
      `select * from "${T}" where "owner" = ? order by "domain" asc, "issuer" asc`,
      [owner],
    );
    return rows.map(toConnection);
  }

  async getConnection(owner: string, issuer: string): Promise<PoppyConnectionRecord | null> {
    const [row] = await this.rows(`select * from "${T}" where "owner" = ? and "issuer" = ?`, [
      owner,
      issuer,
    ]);
    return row ? toConnection(row) : null;
  }

  async saveConnection(record: PoppyConnectionRecord): Promise<void> {
    const insert = `insert into "${T}" ("owner", "issuer", "domain", "organization", "scope", "status", "state", "created_at", "updated_at") values (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    // An upsert on the (owner, issuer) key; `created_at` stays the first save's.
    const sql = this.mysql
      ? `${insert} on duplicate key update "domain" = values("domain"), "organization" = values("organization"), "scope" = values("scope"), "status" = values("status"), "state" = values("state"), "updated_at" = values("updated_at")`
      : `${insert} on conflict ("owner", "issuer") do update set "domain" = excluded."domain", "organization" = excluded."organization", "scope" = excluded."scope", "status" = excluded."status", "state" = excluded."state", "updated_at" = excluded."updated_at"`;
    await this.execute(sql, [
      record.owner,
      record.issuer,
      record.domain,
      record.organization,
      record.scope,
      record.status,
      record.state,
      record.createdAt,
      record.updatedAt,
    ]);
  }

  async deleteConnection(owner: string, issuer: string): Promise<void> {
    await this.execute(`delete from "${T}" where "owner" = ? and "issuer" = ?`, [owner, issuer]);
  }

  async createPending(record: PoppyPendingConnect): Promise<void> {
    const columns = `"id", "owner", "domain", "issuer", "organization", "scope", "actor", "thread_id", "run_id", "tool_call_id", "flow", "status", "expires_at", "created_at"`;
    const values = 'values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
    // Created once: a second create of the same id is a no-op.
    const sql = this.mysql
      ? `insert ignore into "${P}" (${columns}) ${values}`
      : `insert into "${P}" (${columns}) ${values} on conflict ("id") do nothing`;
    await this.execute(sql, [
      record.id,
      record.owner,
      record.domain,
      record.issuer,
      record.organization,
      record.scope,
      record.actor === null ? null : JSON.stringify(record.actor),
      record.threadId,
      record.runId,
      record.toolCallId,
      record.flow,
      record.status,
      record.expiresAt,
      record.createdAt,
    ]);
  }

  async getPending(id: string): Promise<PoppyPendingConnect | null> {
    const [row] = await this.rows(`select * from "${P}" where "id" = ?`, [id]);
    if (!row) return null;
    return {
      id: String(row.id),
      owner: String(row.owner),
      domain: String(row.domain),
      issuer: String(row.issuer),
      organization: String(row.organization),
      scope: String(row.scope ?? ''),
      actor:
        row.actor == null ? null : (JSON.parse(String(row.actor)) as PoppyPendingConnect['actor']),
      threadId: nullable(row.thread_id),
      runId: nullable(row.run_id),
      toolCallId: nullable(row.tool_call_id),
      flow: nullable(row.flow),
      status: String(row.status) as PoppyPendingConnect['status'],
      expiresAt: toInt(row.expires_at),
      createdAt: toInt(row.created_at),
    };
  }

  async updatePending(
    id: string,
    patch: Partial<Pick<PoppyPendingConnect, 'flow' | 'status'>>,
  ): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.flow !== undefined) {
      sets.push('"flow" = ?');
      params.push(patch.flow);
    }
    if (patch.status !== undefined) {
      sets.push('"status" = ?');
      params.push(patch.status);
    }
    if (sets.length === 0) return;
    await this.execute(`update "${P}" set ${sets.join(', ')} where "id" = ?`, [...params, id]);
  }
}

function toConnection(row: Record<string, unknown>): PoppyConnectionRecord {
  return {
    owner: String(row.owner),
    issuer: String(row.issuer),
    domain: String(row.domain),
    organization: String(row.organization),
    scope: String(row.scope ?? ''),
    status: String(row.status) as PoppyConnectionRecord['status'],
    state: String(row.state),
    createdAt: toInt(row.created_at),
    updatedAt: toInt(row.updated_at),
  };
}
