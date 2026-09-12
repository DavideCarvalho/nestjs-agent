// Integration: DrizzleMemoryProvider + ensureAgentSchema against an in-memory SQLite
// (better-sqlite3, via drizzle-orm/better-sqlite3). Runs only under `pnpm test:db`.
import type {
  MemoryProvider,
  MemoryRecord,
  ScopeContext,
  StoreMemoryInput,
} from '@dudousxd/nestjs-agent-core';
import { GLOBAL_SCOPE, actorScope, tenantScope } from '@dudousxd/nestjs-agent-core';
import { everyMemoryField, expectedMemoryRecord } from '@dudousxd/nestjs-agent-testing';
import Database from 'better-sqlite3';
import { sql } from 'drizzle-orm';
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { DrizzleMemoryProvider } from './drizzle-memory-provider.js';
import { ensureAgentSchema } from './ensure-schema.js';
import { type AgentMemoryRow, agentMemory, agentSchema } from './schema.js';

const ctx: ScopeContext = { actor: { id: 'u1', tenantRef: 'org-a' }, threadId: 't1' };
/** Somebody else entirely: another actor, in another tenant. */
const other: ScopeContext = { actor: { id: 'u2', tenantRef: 'org-b' }, threadId: 't2' };
const scopes = [actorScope(ctx.actor), tenantScope('org-a'), GLOBAL_SCOPE];

let db: BetterSQLite3Database<typeof agentSchema>;
let provider: DrizzleMemoryProvider;

beforeEach(async () => {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  db = drizzle(sqlite, { schema: agentSchema });
  await ensureAgentSchema(db);
  provider = new DrizzleMemoryProvider(db);
});

/** A human-authored write, which is the only way a record above the actor's own scope gets in. */
function published(scope: string, key: string, text: string): StoreMemoryInput {
  return { key, text, scope, origin: { author: 'human' }, ctx };
}

async function rows(): Promise<AgentMemoryRow[]> {
  return db.select().from(agentMemory);
}

describe('DrizzleMemoryProvider — the row behind a memory', () => {
  it('is created by `ensureAgentSchema`, like every other agent table', async () => {
    const columns = await db.all<{ name: string }>(sql.raw('PRAGMA table_info(agent_memory)'));

    expect(columns.map((column) => column.name).sort()).toEqual([
      'created_at',
      'id',
      'key',
      'origin_actor_ref',
      'origin_author',
      'origin_run_id',
      'origin_thread_id',
      'pinned',
      'scope',
      'text',
      'updated_at',
    ]);
  });

  it('gets the (scope, key) unique index the upsert conflicts against', async () => {
    const indexes = await db.all<{ name: string; unique: number }>(
      sql.raw('PRAGMA index_list(agent_memory)'),
    );

    expect(indexes.filter((index) => index.unique === 1).map((index) => index.name)).toContain(
      'agent_memory_scope_key_uq',
    );
  });

  it('survives a second `ensureAgentSchema` on a database that already has the table', async () => {
    const written = await provider.write({ ...everyMemoryField(ctx), ctx });

    await ensureAgentSchema(db);

    expect((await rows()).map((row) => row.id)).toEqual([written.id]);
  });

  it('round-trips every field a write is handed, including every origin field', async () => {
    const written = everyMemoryField(ctx);

    const record = await provider.write({ ...written, ctx });

    expect(record).toEqual(expectedMemoryRecord(written, record));
  });

  it('holds one fact per (scope, key), so a rewrite replaces rather than accumulates', async () => {
    const written = everyMemoryField(ctx);

    const first = await provider.write({ ...written, ctx });
    const second = await provider.write({
      ...written,
      text: 'they report on the fiscal year',
      ctx,
    });

    expect(second.id).toBe(first.id);
    expect(await rows()).toHaveLength(1);
    expect(second.text).toBe('they report on the fiscal year');
  });

  it('carries `pinned` across a rewrite of the same (scope, key)', async () => {
    const written = everyMemoryField(ctx);
    const first = await provider.write({ ...written, ctx });
    await provider.pin({ id: first.id, pinned: true });

    const rewritten = await provider.write({ ...written, text: 'restated differently', ctx });

    expect(rewritten.pinned).toBe(true);
  });

  it('leaves `created_at` alone across a rewrite, so when a belief was formed survives', async () => {
    const written = everyMemoryField(ctx);
    const first = await provider.write({ ...written, ctx });
    const createdAt = (await rows())[0]?.createdAt;

    await new Promise((resolve) => setTimeout(resolve, 5));
    await provider.write({ ...written, text: 'restated differently', ctx });

    const after = (await rows())[0];
    expect(after?.id).toBe(first.id);
    expect(after?.createdAt).toEqual(createdAt);
  });

  it('refuses an agent-authored write at any scope but the actor’s own', async () => {
    const written = everyMemoryField(ctx);

    await expect(provider.write({ ...written, scope: tenantScope('org-a'), ctx })).rejects.toThrow(
      'an agent may write only at "actor:u1"',
    );
    expect(await rows()).toEqual([]);
  });

  it('lets a human publish above it, which is what a host console does', async () => {
    const record = await provider.write(
      published(tenantScope('org-a'), 'units', 'report distances in kilometres'),
    );

    expect(record.scope).toBe(tenantScope('org-a'));
  });
});

describe('DrizzleMemoryProvider — scope is a gate in the query', () => {
  it('never selects another actor’s or another tenant’s memory', async () => {
    await provider.write({ ...everyMemoryField(ctx), ctx });
    await provider.write({ ...everyMemoryField(other), ctx: other });
    await provider.write(
      published(tenantScope('org-b'), 'reporting-period', 'they use April to March'),
    );

    const visible = await provider.list({ scopes, ctx });

    expect(visible.map((record) => record.scope)).toEqual([actorScope(ctx.actor)]);
  });

  it('asks the database nothing when the resolver returned no scopes', async () => {
    await provider.write({ ...everyMemoryField(ctx), ctx });

    expect(await provider.list({ scopes: [], ctx })).toEqual([]);
  });

  it('reads the wider scopes an actor does belong to', async () => {
    await provider.write(published(GLOBAL_SCOPE, 'units', 'report distances in kilometres'));
    await provider.write({ ...everyMemoryField(ctx), ctx });

    const visible = await provider.list({ scopes, ctx });

    expect(visible.map((record) => record.scope).sort()).toEqual([
      actorScope(ctx.actor),
      GLOBAL_SCOPE,
    ]);
  });

  it('deletes only from the actor’s own scope, so an id cannot reach a wider one', async () => {
    const tenantMemory = await provider.write(
      published(tenantScope('org-a'), 'units', 'report distances in kilometres'),
    );

    expect(await provider.forget({ id: tenantMemory.id, ctx })).toBe(false);
    expect((await rows()).map((row) => row.id)).toEqual([tenantMemory.id]);
  });

  it('answers a missing id and somebody else’s id identically', async () => {
    const theirs = await provider.write({ ...everyMemoryField(other), ctx: other });

    expect(await provider.forget({ id: theirs.id, ctx })).toBe(false);
    expect(await provider.forget({ id: 'no-such-memory', ctx })).toBe(false);
  });

  it('does delete the actor’s own', async () => {
    const mine = await provider.write({ ...everyMemoryField(ctx), ctx });

    expect(await provider.forget({ id: mine.id, ctx })).toBe(true);
    expect(await rows()).toEqual([]);
  });
});

describe('DrizzleMemoryProvider — pinning', () => {
  it('is set and cleared by the host, and read back off the row', async () => {
    const record = await provider.write({ ...everyMemoryField(ctx), ctx });
    expect(record.pinned).toBe(false);

    expect(await provider.pin({ id: record.id, pinned: true })).toBe(true);
    expect(await readBack(record.id)).toBe(true);

    expect(await provider.pin({ id: record.id, pinned: false })).toBe(true);
    expect(await readBack(record.id)).toBe(false);
  });

  it('reports a miss rather than inventing a row', async () => {
    expect(await provider.pin({ id: 'no-such-memory', pinned: true })).toBe(false);
  });
});

describe('DrizzleMemoryProvider — recall', () => {
  it('offers no `search`, so a turn reads its scopes whole', () => {
    // Through the SPI, which is the shape `offerMemories` probes to choose between the two paths.
    const asProvider: MemoryProvider = provider;

    expect(asProvider.search).toBeUndefined();
  });
});

async function readBack(id: string): Promise<boolean | undefined> {
  const visible: MemoryRecord[] = await provider.list({ scopes, ctx });
  return visible.find((record) => record.id === id)?.pinned;
}
