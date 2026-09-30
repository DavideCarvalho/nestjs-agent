// The chat queue contract against MikroOrmAgentStore on an in-memory SQLite. Runs under `pnpm test:db`.
import { isChatQueueStore } from '@dudousxd/nestjs-agent-core';
import { CHAT_QUEUE_STORE_CONTRACT } from '@dudousxd/nestjs-agent-testing';
import { MikroORM, SqliteDriver } from '@mikro-orm/sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureAgentSchema } from './ensure-schema';
import { agentEntities } from './entities';
import { MikroOrmAgentStore } from './mikro-orm-agent-store';

let orm: MikroORM;
let store: MikroOrmAgentStore;

beforeAll(async () => {
  orm = await MikroORM.init({
    driver: SqliteDriver,
    dbName: ':memory:',
    entities: agentEntities(),
    allowGlobalContext: true,
  });
  await ensureAgentSchema(orm);
  store = new MikroOrmAgentStore(orm.em);
});

afterAll(async () => {
  await orm?.close(true);
});

describe('MikroOrmAgentStore — the chat queue contract', () => {
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

  it('reports the queue and pause of a thread deleted with its queue', async () => {
    const thread = await store.createThread({ actor: { id: 'a' } });
    await store.enqueueMessage({ threadId: thread.id, actor: { id: 'a' }, content: 'x' });
    await orm.em
      .fork()
      .getConnection()
      .execute('DELETE FROM agent_thread WHERE id = ?', [thread.id]);
    expect(await store.listQueue(thread.id)).toEqual([]);
    expect(await store.queuePause(thread.id)).toBeNull();
  });
});
