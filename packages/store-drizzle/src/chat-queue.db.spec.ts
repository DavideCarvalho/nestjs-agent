// The chat queue contract against DrizzleAgentStore on SQLite, Postgres and MySQL. Runs under
// `pnpm test:db`.
import { isChatQueueStore } from '@dudousxd/nestjs-agent-core';
import { CHAT_QUEUE_STORE_CONTRACT } from '@dudousxd/nestjs-agent-testing';
import Database from 'better-sqlite3';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleAgentStore } from './drizzle-agent-store.js';
import { ensureAgentSchema } from './ensure-schema.js';
import { agentSchema } from './schema.js';
import { type AgentDbHandle, describeEachDialect, openAgentDb } from './testing/real-db.js';

describeEachDialect('DrizzleAgentStore — the chat queue contract', (dialect) => {
  let handle: AgentDbHandle;
  let store: DrizzleAgentStore;

  beforeAll(async () => {
    handle = await openAgentDb(dialect);
    store = new DrizzleAgentStore(handle.db);
  });

  afterAll(async () => {
    await handle?.close();
  });

  it('is a ChatQueueStore', () => {
    expect(isChatQueueStore(store)).toBe(true);
  });

  for (const contractCase of CHAT_QUEUE_STORE_CONTRACT) {
    it(contractCase.name, async () => {
      // A fresh thread per case: every queue read is thread-scoped.
      const thread = await store.createThread({ actor: { id: 'contract-actor' } });
      await contractCase.run({ store, threadId: thread.id });
    });
  }

  it('drops a thread’s queue with the thread', async () => {
    const thread = await store.createThread({ actor: { id: 'a' } });
    await store.enqueueMessage({ threadId: thread.id, actor: { id: 'a' }, content: 'x' });
    await handle.run(sql`DELETE FROM agent_thread WHERE id = ${thread.id}`);
    expect(await store.listQueue(thread.id)).toEqual([]);
  });

  // mysql2 counts MATCHED rows by default (its FOUND_ROWS flag); a host that turns the flag off gets
  // CHANGED rows, and re-claiming a thread you already hold changes nothing. Admission must not
  // read that as losing the race.
  it.runIf(dialect === 'mysql')(
    'admits one run per thread when the driver reports changed rows, not matched ones',
    async () => {
      const changedRows = await openAgentDb(dialect, { mysqlFlags: ['-FOUND_ROWS'] });
      try {
        const strict = new DrizzleAgentStore(changedRows.db);
        const admission = CHAT_QUEUE_STORE_CONTRACT.find((contractCase) =>
          contractCase.name.startsWith('admits one run per thread'),
        );
        const thread = await strict.createThread({ actor: { id: 'contract-actor' } });
        await admission?.run({ store: strict, threadId: thread.id });
      } finally {
        await changedRows.close();
      }
    },
  );
});

describe('DrizzleAgentStore — the chat queue on an older SQLite schema', () => {
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
