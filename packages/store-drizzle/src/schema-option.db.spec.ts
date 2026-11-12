import { InMemoryPricingStore } from '@dudousxd/nestjs-agent-testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleAgentStore } from './drizzle-agent-store.js';
import { DrizzleAgentStoreModule } from './drizzle-agent-store.module.js';
import { DrizzleChannelStore } from './drizzle-channel-store.js';
import { DrizzleConfirmTokenStore } from './drizzle-confirm-token-store.js';
import { DrizzleGovernanceQueries } from './drizzle-governance-queries.js';
import { DrizzleStreamFrameTable } from './drizzle-token-stream-sink.js';
import { agentSchemaDdl, ensureAgentSchema } from './ensure-schema.js';
import { type AgentDbHandle, describeEachDialect, openAgentDb } from './testing/real-db.js';

/** Agent tables per schema (Postgres) / database (MySQL), from the catalog. */
async function tablesIn(handle: AgentDbHandle, schema: string | 'current'): Promise<string[]> {
  const filter =
    schema === 'current'
      ? handle.dialect === 'mysql'
        ? 'database()'
        : 'current_schema()'
      : `'${schema}'`;
  const rows = await handle.rows<{ name: string; NAME?: string }>(
    `select table_name as name from information_schema.tables where table_schema = ${filter} and (table_name like 'agent%' or table_name like 'rag%')`,
  );
  return rows.map((row) => String(row.name ?? row.NAME)).sort();
}

describeEachDialect('schema option', (dialect) => {
  if (dialect === 'sqlite') {
    it('fails on SQLite, naming the fix', async () => {
      const handle = await openAgentDb('sqlite', { ensureSchema: false });
      try {
        expect(() => new DrizzleAgentStore(handle.db, { schema: 'agent' })).toThrow(
          /SQLite has no schemas/,
        );
        await expect(ensureAgentSchema(handle.db, { schema: 'agent' })).rejects.toThrow(
          /SQLite has no schemas/,
        );
        expect(() => DrizzleAgentStoreModule.forRoot({ db: handle.db, schema: 'agent' })).toThrow(
          /SQLite has no schemas/,
        );
      } finally {
        await handle.close();
      }
    });
    return;
  }

  const schema = `agent_lib_${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`;
  let handle: AgentDbHandle;

  beforeAll(async () => {
    handle = await openAgentDb(dialect, { ensureSchema: false });
    await ensureAgentSchema(handle.db, { schema });
    // A second boot heals nothing and fails nothing.
    await ensureAgentSchema(handle.db, { schema });
  });

  afterAll(async () => {
    if (dialect === 'mysql') await handle?.run(`drop database if exists \`${schema}\``);
    await handle?.close();
  });

  it('creates the tables in the schema, and none in the connection’s own', async () => {
    const created = await tablesIn(handle, schema);
    expect(created).toContain('agent_thread');
    expect(created).toContain('agent_stream_frame');
    expect(created.length).toBe(19);
    expect(await tablesIn(handle, 'current')).toEqual([]);
  });

  it('reads and writes through every store in the schema', async () => {
    const at = { schema };
    const store = new DrizzleAgentStore(handle.db, at);
    const thread = await store.createThread({ actor: { id: 'u1', roles: [] } });
    await store.appendMessage({ threadId: thread.id, role: 'user', content: 'Hello' });
    await store.recordUsage({
      threadId: thread.id,
      actorRef: 'u1',
      modelId: 'model-x',
      purpose: 'chat',
      usage: { inputTokens: 3, outputTokens: 2 },
    });
    await store.updateThread(thread.id, { title: 'Renamed' });
    expect((await store.getThread(thread.id))?.messages.map((m) => m.content)).toEqual(['Hello']);
    const governance = new DrizzleGovernanceQueries(
      handle.db,
      new InMemoryPricingStore(),
      undefined,
      at,
    );
    const page = await governance.threadsPage({ page: 1, pageSize: 10 });
    expect(page.rows.map((row) => row.threadId)).toEqual([thread.id]);

    const frames = new DrizzleStreamFrameTable(handle.db, at);
    await frames.append('run-1', { frame: 'a', error: null, createdAt: 1 });
    await frames.append('run-1', { frame: 'b', error: null, createdAt: 2 });
    expect((await frames.read('run-1', 0, 10)).map((row) => row.seq)).toEqual([1, 2]);

    const channels = new DrizzleChannelStore(handle.db, at);
    expect(await channels.claim('k', 60_000)).toBe(true);
    const tokens = new DrizzleConfirmTokenStore(handle.db, at);
    expect(
      await tokens.claim({ hash: 'h', actorRef: 'u1', tool: 't', expiresAt: Date.now() + 1000 }),
    ).toBe(true);

    // Every row went to the schema: the qualified table holds it.
    const q = (table: string) =>
      dialect === 'mysql' ? `\`${schema}\`.\`${table}\`` : `"${schema}"."${table}"`;
    const [count] = await handle.rows<{ n: number | string }>(
      `select count(*) as n from ${q('agent_message')}`,
    );
    expect(Number(count?.n)).toBe(1);
    expect(await tablesIn(handle, 'current')).toEqual([]);
  });

  it('binds every store of the module to the schema', async () => {
    const dynamic = DrizzleAgentStoreModule.forRoot({ db: handle.db, schema });
    const provider = (dynamic.providers ?? []).find(
      (entry) =>
        typeof entry === 'object' && 'provide' in entry && entry.provide === DrizzleAgentStore,
    ) as { useFactory: () => DrizzleAgentStore };
    const store = provider.useFactory();
    const thread = await store.createThread({ actor: { id: 'u2', roles: [] } });
    expect((await store.getThread(thread.id))?.id).toBe(thread.id);
    expect(await tablesIn(handle, 'current')).toEqual([]);
  });

  it('renders DDL qualified with the schema', () => {
    const ddl = agentSchemaDdl(dialect, { schema });
    expect(ddl[0]).toMatch(dialect === 'mysql' ? /CREATE DATABASE IF NOT EXISTS/ : /CREATE SCHEMA/);
    const quoted =
      dialect === 'mysql' ? `\`${schema}\`.\`agent_thread\`` : `"${schema}"."agent_thread"`;
    expect(
      ddl.some((statement) => statement.includes(`CREATE TABLE IF NOT EXISTS ${quoted}`)),
    ).toBe(true);
    expect(
      ddl
        .filter((statement) => statement.startsWith('CREATE TABLE'))
        .every((s) => s.includes(`${dialect === 'mysql' ? '`' : '"'}${schema}`)),
    ).toBe(true);
  });
});

describe('schema option validation', () => {
  it('refuses a name that is not a plain identifier', () => {
    expect(() => agentSchemaDdl('postgres', { schema: 'bad"name' })).toThrow(/must match/);
    expect(() => agentSchemaDdl('postgres', { schema: 'x'.repeat(64) })).toThrow(/63/);
  });

  it('without schema renders exactly what it did before', () => {
    expect(agentSchemaDdl('postgres').join('\n')).not.toContain('CREATE SCHEMA');
    expect(agentSchemaDdl('postgres')[0]).toMatch(/^CREATE TABLE IF NOT EXISTS "agent_/);
  });
});
