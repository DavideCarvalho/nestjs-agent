// Integration: the boot heal leaves every agent column in the collation its entity declares.
//
// MikroORM before 7.2 rendered no `collate` clause in `create table` / `add column` and did not diff
// collations at all, so on MySQL every column the heal created came out in the table default
// (`utf8mb4_0900_ai_ci`: case-insensitive) — `agent_channel_state.key`, declared `utf8mb4_bin`,
// included. The MySQL cases reproduce that MikroORM (its column DDL with the clause stripped) and an
// install an earlier version created that way; the Postgres and SQLite cases check the heal leaves
// them alone. Runs only under `pnpm test:db`.
import type { EntitySchema, MikroORM } from '@mikro-orm/core';
import { MySqlSchemaHelper } from '@mikro-orm/mysql';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentSchemaSql } from './agent-schema-sql';
import { ensureAgentSchema } from './ensure-schema';
import { AGENT_COLLATION, agentEntities } from './entities';
import { MikroOrmAgentStore } from './mikro-orm-agent-store';
import { MikroOrmChannelStore } from './mikro-orm-channel-store';
import { AgentSchemaCollationError, declaredCollations } from './mysql-collations';
import { describeEachDialect, openFreshOrm, rawSql } from './testing/real-db';

interface ColumnCollation {
  table: string;
  column: string;
  collation: string | null;
}

async function collationsOf(orm: MikroORM): Promise<ColumnCollation[]> {
  const rows: { t: string; c: string; k: string | null }[] = await rawSql(
    orm,
    "select table_name as t, column_name as c, collation_name as k from information_schema.columns where table_schema = database() and (table_name like 'agent\\_%' or table_name = 'rag_ingestion_log') and table_name <> 'agent_schema_meta'",
  );
  return rows.map((row) => ({ table: row.t, column: row.c, collation: row.k }));
}

/** Every declared column whose actual collation differs from its declaration. */
async function wrongCollations(orm: MikroORM): Promise<string[]> {
  const metadata = [...orm.getMetadata().getAll().values()];
  const declared = declaredCollations(metadata);
  const actual = await collationsOf(orm);
  return actual
    .filter((column) => {
      const want = declared.get(`${column.table}.${column.column}`);
      return want !== undefined && column.collation !== null && column.collation !== want;
    })
    .map((column) => `${column.table}.${column.column}=${column.collation}`);
}

/**
 * The column DDL MikroORM rendered before 7.2: no `collate` clause, in `create table`, `add column`
 * and `modify` alike.
 */
function renderColumnsWithoutCollation(): void {
  const original = MySqlSchemaHelper.prototype.createTableColumn;
  vi.spyOn(MySqlSchemaHelper.prototype, 'createTableColumn').mockImplementation(function (
    this: MySqlSchemaHelper,
    ...args: Parameters<typeof original>
  ) {
    return (original.apply(this, args) ?? '').replace(/ collate [\w]+/gi, '');
  });
}

/** The agent schema as an earlier version left it on MySQL: every column in the table default. */
async function createInstallWithoutCollations(orm: MikroORM): Promise<void> {
  for (const statement of await agentSchemaSql(orm, { ifNotExists: false })) {
    await rawSql(orm, statement.replace(/ collate [\w]+/gi, ''));
  }
}

async function storedFingerprint(orm: MikroORM): Promise<string | undefined> {
  const rows: { fingerprint: string }[] = await rawSql(
    orm,
    "select fingerprint from agent_schema_meta where id = 'agent'",
  );
  return rows[0]?.fingerprint;
}

describeEachDialect('ensureAgentSchema — declared column collations', (dialect) => {
  const opened: MikroORM[] = [];
  async function fresh(entities?: EntitySchema[]): Promise<MikroORM> {
    const instance = await openFreshOrm(dialect, entities !== undefined ? { entities } : {});
    opened.push(instance);
    return instance;
  }

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const instance of opened.splice(0)) await instance.close(true);
  });

  if (dialect !== 'mysql') {
    it('creates and re-heals the schema without naming a collation, and ids stay case-sensitive', async () => {
      const instance = await fresh();
      await ensureAgentSchema(instance);
      // An earlier version's fingerprint: the heal runs again over the existing tables.
      await rawSql(instance, 'delete from agent_schema_meta');
      const store = new MikroOrmAgentStore(instance.em);
      const thread = await store.createThread({ actor: { id: 'a' }, title: 'kept' });

      await ensureAgentSchema(instance);

      expect(await storedFingerprint(instance)).toMatch(/^[a-f0-9]{64}$/);
      expect((await store.getThread(thread.id))?.title).toBe('kept');
      if (dialect === 'postgres') {
        const named: { c: string }[] = await rawSql(
          instance,
          "select table_name || '.' || column_name as c from information_schema.columns where table_schema = current_schema() and table_name like 'agent%' and collation_name is not null",
        );
        expect(named).toEqual([]);
      }
      const channels = new MikroOrmChannelStore(instance.em);
      expect(await channels.claim('wamid.AbC', 60_000)).toBe(true);
      expect(await channels.claim('wamid.aBc', 60_000)).toBe(true);
    });
    return;
  }

  it('creates every column in its declared collation, even where MikroORM renders none', async () => {
    renderColumnsWithoutCollation();
    const instance = await fresh();

    await ensureAgentSchema(instance);

    expect(await wrongCollations(instance)).toEqual([]);
    const key = (await collationsOf(instance)).find(
      (column) => column.table === 'agent_channel_state' && column.column === 'key',
    );
    expect(key?.collation).toBe('utf8mb4_bin');
    const threadId = (await collationsOf(instance)).find(
      (column) => column.table === 'agent_thread' && column.column === 'id',
    );
    expect(threadId?.collation).toBe(AGENT_COLLATION);
    // Provider message ids that differ only by case are different messages.
    const channels = new MikroOrmChannelStore(instance.em);
    expect(await channels.claim('wamid.AbC', 60_000)).toBe(true);
    expect(await channels.claim('wamid.aBc', 60_000)).toBe(true);
    expect(await channels.claim('wamid.AbC', 60_000)).toBe(false);
  });

  it('creates every column in its declared collation with the current MikroORM too', async () => {
    const instance = await fresh();

    await ensureAgentSchema(instance);

    expect(await wrongCollations(instance)).toEqual([]);
  });

  it('corrects an install an earlier version created in the table default, keeping its rows', async () => {
    const instance = await fresh();
    await createInstallWithoutCollations(instance);
    expect((await wrongCollations(instance)).length).toBeGreaterThan(0);
    const store = new MikroOrmAgentStore(instance.em);
    const thread = await store.createThread({ actor: { id: 'owner' }, title: 'Existing chat' });
    await store.appendMessage({ threadId: thread.id, role: 'user', content: 'Keep this message' });
    const channels = new MikroOrmChannelStore(instance.em);
    expect(await channels.claim('wamid.AbC', 60_000)).toBe(true);
    // The bug: under the case-insensitive default, a different message id is taken as answered.
    expect(await channels.claim('wamid.aBc', 60_000)).toBe(false);

    renderColumnsWithoutCollation();
    await ensureAgentSchema(instance);

    expect(await wrongCollations(instance)).toEqual([]);
    expect((await store.getThread(thread.id))?.messages.map((message) => message.content)).toEqual([
      'Keep this message',
    ]);
    expect(await channels.claim('wamid.aBc', 60_000)).toBe(true);
    expect(await channels.claim('wamid.AbC', 60_000)).toBe(false);
    // The foreign keys still hold after the correction.
    await expect(
      rawSql(
        instance,
        "insert into agent_message (id, thread_id, role, content, created_at) values ('m-orphan', 'no-such-thread', 'user', 'x', '2026-01-01 00:00:00')",
      ),
    ).rejects.toThrow(/foreign key/i);
    expect(await storedFingerprint(instance)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('refuses, altering nothing, when two keys would become one under the declared collation', async () => {
    const instance = await fresh();
    await createInstallWithoutCollations(instance);
    // `agent_memory.key` declares the case-insensitive collation; this install has it binary and
    // holds two keys in one scope that differ only by case — distinct under its unique key today.
    await rawSql(
      instance,
      'alter table agent_memory modify `key` varchar(120) collate utf8mb4_bin not null',
    );
    for (const [id, key] of [
      ['m1', 'favorite_color'],
      ['m2', 'FAVORITE_COLOR'],
    ]) {
      await rawSql(
        instance,
        `insert into agent_memory (id, scope, \`key\`, text, origin_author, pinned, created_at, updated_at) values ('${id}', 'user:a', '${key}', 'blue', 'user', 0, '2026-01-01 00:00:00', '2026-01-01 00:00:00')`,
      );
    }

    const healing = ensureAgentSchema(instance);

    await expect(healing).rejects.toThrow(AgentSchemaCollationError);
    await expect(healing).rejects.toThrow(
      /agent_memory\.agent_memory_scope_key_uq \(scope, key\) would hold 2 rows/,
    );
    const memoryKey = (await collationsOf(instance)).find(
      (column) => column.table === 'agent_memory' && column.column === 'key',
    );
    expect(memoryKey?.collation).toBe('utf8mb4_bin');
    // Nothing else was altered either, and the next boot checks again.
    const key = (await collationsOf(instance)).find(
      (column) => column.table === 'agent_channel_state' && column.column === 'key',
    );
    expect(key?.collation).toBe('utf8mb4_0900_ai_ci');
    expect(await storedFingerprint(instance)).toBeUndefined();
  });

  it('refuses when a child row only matches its parent case-insensitively', async () => {
    // A host that registers every string column binary.
    const entities = agentEntities({ collation: 'utf8mb4_bin' });
    const instance = await fresh(entities);
    await createInstallWithoutCollations(instance);
    await rawSql(
      instance,
      "insert into agent_thread (id, actor_ref, title, transient, created_at, updated_at) values ('thread-a', 'a', 't', 0, '2026-01-01 00:00:00', '2026-01-01 00:00:00')",
    );
    await rawSql(
      instance,
      "insert into agent_message (id, thread_id, role, content, created_at) values ('m1', 'THREAD-A', 'user', 'x', '2026-01-01 00:00:00')",
    );

    await expect(ensureAgentSchema(instance)).rejects.toThrow(
      /agent_message\.thread_id would no longer match agent_thread\.id/,
    );
    expect(await storedFingerprint(instance)).toBeUndefined();

    // Fixed by hand, the next boot corrects the columns.
    await rawSql(instance, "update agent_message set thread_id = 'thread-a' where id = 'm1'");
    await ensureAgentSchema(instance);
    expect(await wrongCollations(instance)).toEqual([]);
  });
});

describe('declaredCollations', () => {
  it('reads the collation every agent string column declares, foreign keys included', async () => {
    const { MikroORM } = await import('@mikro-orm/sqlite');
    const { SqliteDriver } = await import('@mikro-orm/sqlite');
    const orm = await MikroORM.init({
      driver: SqliteDriver,
      dbName: ':memory:',
      entities: agentEntities({ collation: AGENT_COLLATION }),
      allowGlobalContext: true,
      connect: false,
    } as never);
    try {
      const declared = declaredCollations([...orm.getMetadata().getAll().values()]);
      expect(declared.get('agent_channel_state.key')).toBe('utf8mb4_bin');
      expect(declared.get('agent_thread.id')).toBe(AGENT_COLLATION);
      expect(declared.get('agent_thread.actor_ref')).toBe('utf8mb4_bin');
      expect(declared.get('agent_message.thread_id')).toBe(AGENT_COLLATION);
    } finally {
      await orm.close(true);
    }
  });
});
