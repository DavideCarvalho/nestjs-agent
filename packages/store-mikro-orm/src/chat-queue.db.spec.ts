// The chat queue contract against MikroOrmAgentStore on SQLite, Postgres and MySQL. Runs under
// `pnpm test:db`.
import { isChatQueueStore } from '@dudousxd/nestjs-agent-core';
import { CHAT_QUEUE_STORE_CONTRACT } from '@dudousxd/nestjs-agent-testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { MikroOrmAgentStore } from './mikro-orm-agent-store';
import { type AgentOrmHandle, describeEachDialect, openAgentOrm, rawSql } from './testing/real-db';

describeEachDialect('MikroOrmAgentStore — the chat queue contract', (dialect) => {
  let handle: AgentOrmHandle;
  let store: MikroOrmAgentStore;

  beforeAll(async () => {
    handle = await openAgentOrm(dialect);
    store = new MikroOrmAgentStore(handle.orm.em);
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

  // mysql2 counts MATCHED rows by default (its FOUND_ROWS flag); a host that turns the flag off gets
  // CHANGED rows, and re-claiming a thread you already hold changes nothing. Admission must not
  // read that as losing the race.
  it.runIf(dialect === 'mysql')(
    'admits one run per thread when the driver reports changed rows, not matched ones',
    async () => {
      const changedRows = await openAgentOrm(dialect, {
        config: { driverOptions: { flags: ['-FOUND_ROWS'] } },
      });
      try {
        const strict = new MikroOrmAgentStore(changedRows.orm.em);
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

  it('reports the queue and pause of a thread deleted with its queue', async () => {
    const thread = await store.createThread({ actor: { id: 'a' } });
    await store.enqueueMessage({ threadId: thread.id, actor: { id: 'a' }, content: 'x' });
    await rawSql(handle.orm, 'DELETE FROM agent_thread WHERE id = ?', [thread.id]);
    expect(await store.listQueue(thread.id)).toEqual([]);
    expect(await store.queuePause(thread.id)).toBeNull();
  });
});
