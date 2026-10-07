import { createHash } from 'node:crypto';
import type { ChannelStore } from '@dudousxd/nestjs-agent-core';
import { and, eq, gt, lte } from 'drizzle-orm';
import {
  type AgentDialect,
  type AgentDrizzleDb,
  type AgentSqliteDb,
  type AgentTables,
  affectedRows,
  agentDialectOf,
  agentTablesFor,
  asBuilder,
  mysqlAffectedRows,
  upsert,
} from './dialect.js';

/** The slice of Drizzle's MySQL insert builder used here, which the SQLite view does not have. */
interface MySqlInsertIgnore<Row> {
  ignore(): { values(value: Row): PromiseLike<unknown> };
}

/** Keys longer than the column are stored by their hash. */
const channelStateKey = (key: string): string =>
  key.length <= 255 ? key : `sha256:${createHash('sha256').update(key).digest('hex')}`;

export interface DrizzleChannelStoreOptions {
  /** How often a claim also deletes expired rows. Default 10 minutes; `0` → never (purge yourself). */
  purgeEveryMs?: number;
}

/**
 * A `ChannelStore` (text channels, `@dudousxd/nestjs-agent-channels`) over the `agent_channel_state`
 * table — shared by every replica, no Redis needed.
 *
 * A claim deletes the key's row when it expired, then inserts it skipping a duplicate key —
 * `ON CONFLICT DO NOTHING` on SQLite and Postgres, `INSERT IGNORE` on MySQL — so the primary key is
 * the lock: of two concurrent claims one inserts and the other touches no row. Expired rows are
 * deleted as claims arrive (`purgeEveryMs`), or by {@link purgeExpired} from a job. The table comes
 * from `ensureAgentSchema` (or your own migration).
 */
export class DrizzleChannelStore implements ChannelStore {
  private readonly db: AgentSqliteDb;
  private readonly dialect: AgentDialect;
  private readonly t: AgentTables;
  private readonly purgeEveryMs: number;
  private lastPurge = 0;

  constructor(db: AgentDrizzleDb, options: DrizzleChannelStoreOptions = {}) {
    this.dialect = agentDialectOf(db);
    this.t = agentTablesFor(this.dialect);
    this.db = asBuilder(db);
    this.purgeEveryMs = options.purgeEveryMs ?? 10 * 60 * 1000;
  }

  async claim(key: string, ttlMs: number): Promise<boolean> {
    const table = this.t.agentChannelState;
    const now = Date.now();
    if (this.purgeEveryMs > 0 && now - this.lastPurge >= this.purgeEveryMs) {
      this.lastPurge = now;
      await this.purgeExpired(now);
    }
    const id = channelStateKey(key);
    // An expired claim is free again.
    await this.db.delete(table).where(and(eq(table.key, id), lte(table.expiresAt, now)));
    const row = { key: id, value: null, expiresAt: now + ttlMs, createdAt: now };
    if (this.dialect === 'mysql') {
      // MySQL's insert builder: `INSERT IGNORE`, and the header's affectedRows is 0 on a duplicate.
      const insert = this.db.insert(table) as unknown as MySqlInsertIgnore<typeof row>;
      return mysqlAffectedRows(await insert.ignore().values(row)) === 1;
    }
    const inserted = await affectedRows(
      this.dialect,
      this.db.insert(table).values(row).onConflictDoNothing(),
      table.key,
    );
    return inserted === 1;
  }

  async get(key: string): Promise<string | null> {
    const table = this.t.agentChannelState;
    const rows = await this.db
      .select({ value: table.value })
      .from(table)
      .where(and(eq(table.key, channelStateKey(key)), gt(table.expiresAt, Date.now())));
    const value = rows[0]?.value;
    return typeof value === 'string' ? value : null;
  }

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    const table = this.t.agentChannelState;
    const now = Date.now();
    await upsert(
      this.dialect,
      this.db
        .insert(table)
        .values({ key: channelStateKey(key), value, expiresAt: now + ttlMs, createdAt: now }),
      table.key,
      { value, expiresAt: now + ttlMs },
    );
  }

  async delete(key: string): Promise<void> {
    const table = this.t.agentChannelState;
    await this.db.delete(table).where(eq(table.key, channelStateKey(key)));
  }

  async purgeExpired(now: number = Date.now()): Promise<number> {
    const table = this.t.agentChannelState;
    return affectedRows(
      this.dialect,
      this.db.delete(table).where(lte(table.expiresAt, now)),
      table.key,
    );
  }
}
