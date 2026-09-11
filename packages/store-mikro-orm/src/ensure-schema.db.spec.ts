// Integration: ensureAgentSchema healing a real SQLite database (better-sqlite3, via
// @mikro-orm/sqlite). Runs only under `pnpm test:db`.
import { EntitySchema, MikroORM } from '@mikro-orm/core';
import { SqliteDriver } from '@mikro-orm/sqlite';
import { describe, expect, it } from 'vitest';
import { agentSchemaSql } from './agent-schema-sql';
import { ensureAgentSchema } from './ensure-schema';
import { agentEntities } from './entities';
import { MikroOrmAgentStore } from './mikro-orm-agent-store';

/** An `agent_thread` from an older revision of the lib: no tenant, stream, agent or soft delete. */
const THREAD_BEFORE_COLUMNS_WERE_ADDED = `create table agent_thread (
  id text not null primary key,
  actor_ref text not null,
  title text not null,
  transient integer not null default 0,
  created_at datetime not null,
  updated_at datetime not null
)`;

/** An `agent_run` from before a child run recorded which run delegated it. */
const RUN_BEFORE_PARENT_WAS_RECORDED = `create table agent_run (
  id text not null primary key,
  thread_id text not null,
  actor_ref text not null,
  agent_name text null,
  status text not null,
  duration_ms integer null,
  error_code text null,
  error_message text null,
  retries integer not null default 0,
  started_at datetime not null,
  settled_at datetime null,
  prompt_hash text null,
  constraint agent_run_thread_id_foreign foreign key (thread_id) references agent_thread (id) on delete cascade
)`;

/** A host table the store does not own, missing a column its entity declares. */
class HostNote {
  id!: string;
  body!: string;
  pinned?: boolean | null;
}

const hostNoteSchema = new EntitySchema<HostNote>({
  class: HostNote,
  tableName: 'host_note',
  properties: {
    id: { type: 'string', primary: true },
    body: { type: 'string' },
    pinned: { type: 'boolean', nullable: true },
  },
});

async function orm(extra: EntitySchema[] = []): Promise<MikroORM> {
  return MikroORM.init({
    driver: SqliteDriver,
    dbName: ':memory:',
    entities: [...agentEntities(), ...extra],
    allowGlobalContext: true,
  });
}

async function columnsOf(instance: MikroORM, table: string): Promise<string[]> {
  // `Connection.execute` resolves to `any`, so the row shape is declared here rather than inferred.
  const info: { name: string }[] = await instance.em
    .getConnection()
    .execute(`pragma table_info(${table})`);
  return info.map((column) => column.name);
}

async function foreignKeysEnforced(instance: MikroORM): Promise<boolean> {
  const rows: { foreign_keys: number }[] = await instance.em
    .getConnection()
    .execute('pragma foreign_keys');
  return Boolean(rows[0]?.foreign_keys);
}

async function storedFingerprint(instance: MikroORM): Promise<string | undefined> {
  const rows: { fingerprint: string }[] = await instance.em
    .getConnection()
    .execute("select fingerprint from agent_schema_meta where id = 'agent'");
  return rows[0]?.fingerprint;
}

/**
 * SQLite has no `add column` for most changes: MikroORM emits a table REBUILD (create a
 * `__temp_alter` twin, copy the rows into it, drop the original, rename). The heal has to apply that
 * whole sequence — and when it cannot, it has to say so instead of stamping the fingerprint that
 * stops every later boot from trying again.
 */
describe('ensureAgentSchema — healing a table that is missing columns', () => {
  it('adds the columns, keeps the rows, and only then records the fingerprint', async () => {
    const instance = await orm();
    try {
      const connection = instance.em.getConnection();
      await connection.execute(THREAD_BEFORE_COLUMNS_WERE_ADDED);
      await connection.execute(
        "insert into agent_thread values ('t1', 'actor-1', 'Old chat', 0, '2026-01-01 00:00:00', '2026-01-02 00:00:00')",
      );

      await ensureAgentSchema(instance);

      expect(await columnsOf(instance, 'agent_thread')).toEqual([
        'id',
        'actor_ref',
        'tenant_ref',
        'title',
        'transient',
        'active_stream_id',
        'default_agent',
        'created_at',
        'updated_at',
        'deleted_at',
      ]);
      const store = new MikroOrmAgentStore(instance.em);
      expect((await store.getThread('t1'))?.title).toBe('Old chat');
      await store.updateThread('t1', { defaultAgent: 'researcher' });
      expect(await store.defaultAgentForThread('t1')).toBe('researcher');
      expect(await storedFingerprint(instance)).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      await instance.close(true);
    }
  });

  it('keeps the child rows a dropped parent would have cascaded away, and restores enforcement', async () => {
    const instance = await orm();
    try {
      const connection = instance.em.getConnection();
      // Current children, an `agent_thread` from before the columns were added, and rows in both.
      for (const sql of await agentSchemaSql(instance, { ifNotExists: false })) {
        await connection.execute(sql);
      }
      await connection.execute('drop table agent_thread');
      await connection.execute(THREAD_BEFORE_COLUMNS_WERE_ADDED);
      await connection.execute(
        "insert into agent_thread values ('t1', 'actor-1', 'Old chat', 0, '2026-01-01 00:00:00', '2026-01-02 00:00:00')",
      );
      const store = new MikroOrmAgentStore(instance.em);
      await store.appendMessage({ threadId: 't1', role: 'user', content: 'still here' });
      expect(await foreignKeysEnforced(instance)).toBe(true);

      await ensureAgentSchema(instance);

      expect((await store.getThread('t1'))?.messages.map((message) => message.content)).toEqual([
        'still here',
      ]);
      expect(await foreignKeysEnforced(instance)).toBe(true);
    } finally {
      await instance.close(true);
    }
  });

  it('adds a column to a table that already has rows and children', async () => {
    const instance = await orm();
    try {
      const connection = instance.em.getConnection();
      for (const sql of await agentSchemaSql(instance, { ifNotExists: false })) {
        await connection.execute(sql);
      }
      // `agent_run` as it stood before the delegation edge was recorded.
      await connection.execute('drop table agent_run');
      await connection.execute(RUN_BEFORE_PARENT_WAS_RECORDED);
      await connection.execute(
        "insert into agent_thread (id, actor_ref, title, transient, created_at, updated_at) values ('t1', 'a1', 'Chat', 0, '2026-01-01', '2026-01-01')",
      );
      await connection.execute(
        "insert into agent_run (id, thread_id, actor_ref, status, retries, started_at) values ('r1', 't1', 'a1', 'completed', 0, '2026-01-01')",
      );

      await ensureAgentSchema(instance);

      expect(await columnsOf(instance, 'agent_run')).toContain('parent_run_id');
      const rows: { id: string }[] = await connection.execute('select id from agent_run');
      expect(rows.map((row) => row.id)).toEqual(['r1']);
    } finally {
      await instance.close(true);
    }
  });

  it('leaves a host table the store does not own untouched', async () => {
    const instance = await orm([hostNoteSchema]);
    try {
      const connection = instance.em.getConnection();
      await connection.execute(THREAD_BEFORE_COLUMNS_WERE_ADDED);
      await connection.execute(
        'create table host_note (id text not null primary key, body text not null)',
      );
      await connection.execute("insert into host_note values ('n1', 'host row')");

      await ensureAgentSchema(instance);

      expect(await columnsOf(instance, 'host_note')).toEqual(['id', 'body']);
      const rows: { id: string }[] = await connection.execute('select id from host_note');
      expect(rows.map((row) => row.id)).toEqual(['n1']);
    } finally {
      await instance.close(true);
    }
  });

  it('throws and records nothing when the statements the diff asked for do not land', async () => {
    const instance = await orm();
    try {
      const connection = instance.em.getConnection();
      await connection.execute(THREAD_BEFORE_COLUMNS_WERE_ADDED);
      // A database that accepts the whole rebuild and does nothing with it — the shape the bug had,
      // and the shape a filtered-out statement, a silent driver and a lying proxy all share.
      const execute = connection.execute.bind(connection);
      connection.execute = (async (query: string, ...rest: unknown[]) =>
        typeof query === 'string' && /__temp_alter|^drop\s+table/i.test(query)
          ? []
          : execute(query, ...(rest as []))) as typeof connection.execute;

      await expect(ensureAgentSchema(instance)).rejects.toThrow(/agent schema heal did not apply/i);

      expect(await columnsOf(instance, 'agent_thread')).not.toContain('default_agent');
      expect(await storedFingerprint(instance)).toBeUndefined();
      // A boot that failed must not leave the connection writing without its foreign keys.
      expect(await foreignKeysEnforced(instance)).toBe(true);
    } finally {
      await instance.close(true);
    }
  });
});
