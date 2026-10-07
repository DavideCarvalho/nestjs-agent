import { createHash } from 'node:crypto';
import type { ChannelStore } from '@dudousxd/nestjs-agent-core';
import type { EntityManager } from '@mikro-orm/core';

/** How many rows a native write touched, whatever the driver reports it as. */
function affected(result: unknown): number {
  const count = (result as { affectedRows?: unknown } | null)?.affectedRows;
  return typeof count === 'number' ? count : 0;
}

/** Keys longer than the column are stored by their hash. */
const storedKey = (key: string): string =>
  key.length <= 255 ? key : `sha256:${createHash('sha256').update(key).digest('hex')}`;

export interface MikroOrmChannelStoreOptions {
  /** How often a claim also deletes expired rows. Default 10 minutes; `0` → never (purge yourself). */
  purgeEveryMs?: number;
}

/**
 * A `ChannelStore` (text channels, `@dudousxd/nestjs-agent-channels`) over the `agent_channel_state`
 * table — shared by every replica, no Redis needed. A POJO receiving an {@link EntityManager}; each
 * operation runs on a fresh `em.fork()`.
 *
 * A claim deletes the key's row when it expired, then inserts it skipping a duplicate key
 * (`ON CONFLICT DO NOTHING`; `INSERT IGNORE` on MySQL), so the primary key is the lock: of two
 * concurrent claims one inserts and the other touches no row — a statement that does not FAIL on
 * the duplicate, because on Postgres a failed statement aborts the transaction it ran in. Expired
 * rows are deleted as claims arrive (`purgeEveryMs`), or by {@link purgeExpired} from a job.
 */
export class MikroOrmChannelStore implements ChannelStore {
  private readonly purgeEveryMs: number;
  private lastPurge = 0;

  constructor(
    private readonly em: EntityManager,
    options: MikroOrmChannelStoreOptions = {},
  ) {
    this.purgeEveryMs = options.purgeEveryMs ?? 10 * 60 * 1000;
  }

  private get mysql(): boolean {
    const platform = this.em.getPlatform().constructor.name.toLowerCase();
    return platform.includes('mysql') || platform.includes('maria');
  }

  /** `sql` with `"identifiers"` quoted for the platform — `key` is reserved on MySQL. */
  private sql(statement: string): string {
    return this.mysql ? statement.replaceAll('"', '`') : statement;
  }

  private execute(statement: string, params: unknown[], method: 'run' | 'all' = 'run') {
    return this.em.fork().getConnection().execute(this.sql(statement), params, method);
  }

  async claim(key: string, ttlMs: number): Promise<boolean> {
    const now = Date.now();
    if (this.purgeEveryMs > 0 && now - this.lastPurge >= this.purgeEveryMs) {
      this.lastPurge = now;
      await this.purgeExpired(now);
    }
    const id = storedKey(key);
    // An expired claim is free again.
    await this.execute('delete from "agent_channel_state" where "key" = ? and "expires_at" <= ?', [
      id,
      now,
    ]);
    const insert = this.mysql
      ? 'insert ignore into "agent_channel_state" ("key", "value", "expires_at", "created_at") values (?, null, ?, ?)'
      : 'insert into "agent_channel_state" ("key", "value", "expires_at", "created_at") values (?, null, ?, ?) on conflict ("key") do nothing';
    return affected(await this.execute(insert, [id, now + ttlMs, now])) === 1;
  }

  async get(key: string): Promise<string | null> {
    const rows = (await this.execute(
      'select "value" from "agent_channel_state" where "key" = ? and "expires_at" > ?',
      [storedKey(key), Date.now()],
      'all',
    )) as { value?: unknown }[];
    const value = rows[0]?.value;
    return typeof value === 'string' ? value : null;
  }

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    const now = Date.now();
    const upsert = this.mysql
      ? 'insert into "agent_channel_state" ("key", "value", "expires_at", "created_at") values (?, ?, ?, ?) on duplicate key update "value" = values("value"), "expires_at" = values("expires_at")'
      : 'insert into "agent_channel_state" ("key", "value", "expires_at", "created_at") values (?, ?, ?, ?) on conflict ("key") do update set "value" = excluded."value", "expires_at" = excluded."expires_at"';
    await this.execute(upsert, [storedKey(key), value, now + ttlMs, now]);
  }

  async delete(key: string): Promise<void> {
    await this.execute('delete from "agent_channel_state" where "key" = ?', [storedKey(key)]);
  }

  async purgeExpired(now: number = Date.now()): Promise<number> {
    return affected(
      await this.execute('delete from "agent_channel_state" where "expires_at" <= ?', [now]),
    );
  }
}
