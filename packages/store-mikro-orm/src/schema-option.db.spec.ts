// Integration: the `schema` option on SQLite (refused), Postgres and MySQL. Runs only under `pnpm test:db`.
import { InMemoryPricingStore } from '@dudousxd/nestjs-agent-testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { agentSchemaSql } from './agent-schema-sql';
import { ensureAgentSchema } from './ensure-schema';
import { MikroOrmAgentStore } from './mikro-orm-agent-store';
import { MikroOrmAgentStoreModule } from './mikro-orm-agent-store.module';
import { MikroOrmChannelStore } from './mikro-orm-channel-store';
import { MikroOrmConfirmTokenStore } from './mikro-orm-confirm-token-store';
import { MikroOrmGovernanceQueries } from './mikro-orm-governance-queries';
import { MikroOrmMemoryProvider } from './mikro-orm-memory-provider';
import { MikroOrmPoppyConnectionStore } from './mikro-orm-poppy-connection-store';
import { MikroOrmPricingStore } from './mikro-orm-pricing-store';
import { MikroOrmStreamFrameTable } from './mikro-orm-token-stream-sink';
import { type AgentOrmHandle, describeEachDialect, openAgentOrm, rawSql } from './testing/real-db';

describeEachDialect('schema option', (dialect) => {
  if (dialect === 'sqlite') {
    it('fails on SQLite, naming the fix', async () => {
      const handle = await openAgentOrm('sqlite', { ensureSchema: false });
      try {
        expect(() => new MikroOrmAgentStore(handle.orm.em, { schema: 'agent' })).toThrow(
          /SQLite has no schemas/,
        );
        await expect(ensureAgentSchema(handle.orm, { schema: 'agent' })).rejects.toThrow(
          /SQLite has no schemas/,
        );
      } finally {
        await handle.close();
      }
    });
    return;
  }

  const schema = `agent_lib_${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`;
  let handle: AgentOrmHandle;

  /** Agent tables (and the marker) in `which` schema/database, from the catalog. */
  async function tablesIn(which: string | 'current'): Promise<string[]> {
    const filter =
      which === 'current'
        ? dialect === 'mysql'
          ? 'database()'
          : 'current_schema()'
        : `'${which}'`;
    const rows = await rawSql<{ name?: string; NAME?: string }[]>(
      handle.orm,
      `select table_name as name from information_schema.tables where table_schema = ${filter} and (table_name like 'agent%' or table_name like 'rag%')`,
    );
    return rows.map((row) => String(row.name ?? row.NAME)).sort();
  }

  const q = (table: string) =>
    dialect === 'mysql' ? `\`${schema}\`.\`${table}\`` : `"${schema}"."${table}"`;

  beforeAll(async () => {
    handle = await openAgentOrm(dialect, { ensureSchema: false });
    await ensureAgentSchema(handle.orm, { schema });
    // A second boot reads the fingerprint in the schema and heals nothing.
    await ensureAgentSchema(handle.orm, { schema });
  });

  afterAll(async () => {
    if (dialect === 'mysql') await rawSql(handle.orm, `drop database if exists \`${schema}\``);
    await handle?.close();
  });

  it('creates every table and the boot marker in the schema, and none in the connection’s own', async () => {
    const created = await tablesIn(schema);
    expect(created).toContain('agent_thread');
    expect(created).toContain('agent_schema_meta');
    expect(created).toHaveLength(20);
    expect(await tablesIn('current')).toEqual([]);
  });

  it('reads and writes through every store in the schema', async () => {
    const at = { schema };
    const em = handle.orm.em;
    const store = new MikroOrmAgentStore(em, at);
    const thread = await store.createThread({ actor: { id: 'u1', roles: [] } });
    await store.appendMessage({ threadId: thread.id, role: 'user', content: 'Hello' });
    await store.recordUsage({
      threadId: thread.id,
      actorRef: 'u1',
      modelId: 'model-x',
      purpose: 'chat',
      usage: { inputTokens: 3, outputTokens: 2 },
    });
    expect((await store.quotaToday('u1', new Date().toISOString().slice(0, 10))).usedTokens).toBe(
      5,
    );
    expect((await store.getThread(thread.id))?.messages.map((m) => m.content)).toEqual(['Hello']);

    const governance = new MikroOrmGovernanceQueries(em, new InMemoryPricingStore(), undefined, at);
    expect(
      (await governance.threadsPage({ page: 1, pageSize: 10 })).rows.map((r) => r.threadId),
    ).toEqual([thread.id]);

    const frames = new MikroOrmStreamFrameTable(em, at);
    await frames.append('run-1', { frame: 'a', error: null, createdAt: 1 });
    await frames.append('run-1', { frame: 'b', error: null, createdAt: 2 });
    expect((await frames.read('run-1', 0, 10)).map((row) => Number(row.seq))).toEqual([1, 2]);

    expect(await new MikroOrmChannelStore(em, at).claim('k', 60_000)).toBe(true);
    expect(
      await new MikroOrmConfirmTokenStore(em, at).claim({
        hash: 'h',
        actorRef: 'u1',
        tool: 't',
        expiresAt: Date.now() + 1000,
      }),
    ).toBe(true);
    await new MikroOrmPricingStore(em, at).upsertModelPrice({
      modelId: 'model-x',
      inputPricePer1m: 1,
      outputPricePer1m: 2,
    });
    expect(await new MikroOrmPoppyConnectionStore(em, at).listConnections('nobody')).toEqual([]);
    expect(
      await new MikroOrmMemoryProvider(em, at).list({ scopes: ['actor:u1'] } as never),
    ).toEqual([]);

    const [count] = await rawSql<{ n: number | string }[]>(
      handle.orm,
      `select count(*) as n from ${q('agent_message')}`,
    );
    expect(Number(count?.n)).toBe(1);
    expect(await tablesIn('current')).toEqual([]);
  });

  it('runs inside the app’s own transaction, in the schema', async () => {
    const store = new MikroOrmAgentStore(handle.orm.em, { schema });
    let id = '';
    await handle.orm.em.fork().transactional(async () => {
      id = (await store.createThread({ actor: { id: 'u3', roles: [] } })).id;
    });
    const [row] = await rawSql<{ n: number | string }[]>(
      handle.orm,
      `select count(*) as n from ${q('agent_thread')} where id = ?`,
      [id],
    );
    expect(Number(row?.n)).toBe(1);
  });

  it('binds every store of the module to the schema', async () => {
    const dynamic = MikroOrmAgentStoreModule.forFeature({ schema, autoSchema: false });
    const provider = (dynamic.providers ?? []).find(
      (entry) =>
        typeof entry === 'object' && 'provide' in entry && entry.provide === MikroOrmAgentStore,
    ) as { useFactory: (em: unknown) => MikroOrmAgentStore };
    const store = provider.useFactory(handle.orm.em);
    const thread = await store.createThread({ actor: { id: 'u2', roles: [] } });
    expect((await store.getThread(thread.id))?.id).toBe(thread.id);
  });

  it('renders migration DDL in the schema', async () => {
    const statements = await agentSchemaSql(handle.orm, { schema });
    expect(statements[0]).toMatch(
      dialect === 'mysql' ? /create database if not exists/ : /create schema if not exists/,
    );
    const tables = statements.filter((statement) => /^create table/i.test(statement));
    expect(tables.length).toBeGreaterThan(10);
    const qualifier = dialect === 'mysql' ? `\`${schema}\`.` : `"${schema}".`;
    expect(tables.every((statement) => statement.includes(qualifier))).toBe(true);
  });
});
