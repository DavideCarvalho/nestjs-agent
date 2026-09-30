// The chat queue contract against DrizzleAgentStore on an in-memory SQLite. Runs under `pnpm test:db`.
import { isChatQueueStore } from '@dudousxd/nestjs-agent-core';
import { CHAT_QUEUE_STORE_CONTRACT } from '@dudousxd/nestjs-agent-testing';
import Database from 'better-sqlite3';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, expect, it } from 'vitest';
import { DrizzleAgentStore } from './drizzle-agent-store.js';
import { ensureAgentSchema } from './ensure-schema.js';
import { agentSchema } from './schema.js';

async function freshStore() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema: agentSchema });
  await ensureAgentSchema(db);
  return { db, store: new DrizzleAgentStore(db) };
}

describe('DrizzleAgentStore — the chat queue contract', () => {
  it('is a ChatQueueStore', async () => {
    expect(isChatQueueStore((await freshStore()).store)).toBe(true);
  });

  for (const contractCase of CHAT_QUEUE_STORE_CONTRACT) {
    it(contractCase.name, async () => {
      const { store } = await freshStore();
      const thread = await store.createThread({ actor: { id: 'contract-actor' } });
      await contractCase.run({ store, threadId: thread.id });
    });
  }

  it('drops a thread’s queue with the thread', async () => {
    const { db, store } = await freshStore();
    const thread = await store.createThread({ actor: { id: 'a' } });
    await store.enqueueMessage({ threadId: thread.id, actor: { id: 'a' }, content: 'x' });
    await db.run(sql`DELETE FROM agent_thread WHERE id = ${thread.id}`);
    expect(await store.listQueue(thread.id)).toEqual([]);
  });

  it('adds the pause column to a thread table created before the queue existed', async () => {
    const sqlite = new Database(':memory:');
    const db = drizzle(sqlite, { schema: agentSchema });
    await db.run(
      sql.raw(`CREATE TABLE agent_thread (
        id TEXT PRIMARY KEY NOT NULL, actor_ref TEXT NOT NULL, tenant_ref TEXT, title TEXT NOT NULL,
        transient INTEGER NOT NULL DEFAULT 0, active_stream_id TEXT, default_agent TEXT, model TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER)`),
    );
    await ensureAgentSchema(db);
    const store = new DrizzleAgentStore(db);
    const thread = await store.createThread({ actor: { id: 'a' } });
    const pause = { reason: 'cancelled' as const, at: '2026-01-01T00:00:00.000Z' };
    await store.setQueuePause(thread.id, pause);
    expect(await store.queuePause(thread.id)).toEqual(pause);
  });
});
