// Integration: MikroOrmPoppyStore / MikroOrmPoppyConnectionStore on SQLite, Postgres and MySQL. Runs
// only under `pnpm test:db`.
import { POPPY_CONNECTION_TABLES, POPPY_TABLES } from '@dudousxd/nestjs-agent-core';
import {
  POPPY_CONNECTION_STORE_CONTRACT,
  POPPY_STORE_CONTRACT,
  poppyConversationFixture,
} from '@dudousxd/nestjs-agent-testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MikroOrmPoppyConnectionStore } from './mikro-orm-poppy-connection-store';
import { MikroOrmPoppyStore } from './mikro-orm-poppy-store';
import {
  type AgentOrmHandle,
  columnsOf,
  describeEachDialect,
  indexesOf,
  openAgentOrm,
  rawSql,
} from './testing/real-db';

const ALL_TABLES = [...Object.values(POPPY_TABLES), ...Object.values(POPPY_CONNECTION_TABLES)];

describeEachDialect('MikroORM Poppy stores', (dialect) => {
  let handle: AgentOrmHandle;

  beforeAll(async () => {
    handle = await openAgentOrm(dialect);
  });

  afterAll(async () => {
    await handle?.close();
  });

  async function clear() {
    for (const table of ALL_TABLES) await rawSql(handle.orm, `delete from ${table}`);
  }

  describe('the Poppy store contract', () => {
    for (const contractCase of POPPY_STORE_CONTRACT) {
      it(contractCase.name, async () => {
        await clear();
        await contractCase.run({ store: new MikroOrmPoppyStore(handle.orm.em) });
      });
    }
  });

  describe('the Poppy connection store contract', () => {
    for (const contractCase of POPPY_CONNECTION_STORE_CONTRACT) {
      it(contractCase.name, async () => {
        await clear();
        await contractCase.run({ store: new MikroOrmPoppyConnectionStore(handle.orm.em) });
      });
    }
  });

  it('creates the Poppy tables at boot, keyed for the races', async () => {
    for (const table of ALL_TABLES) {
      expect((await columnsOf(handle.orm, table)).length).toBeGreaterThan(0);
    }
    expect(await indexesOf(handle.orm, POPPY_TABLES.events)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'agent_poppy_event_key_idx',
          unique: true,
          columns: ['conversation_id', 'event_key'],
        }),
      ]),
    );
  });

  it('appends from two replicas at distinct positions', async () => {
    await clear();
    const replica = await handle.replica();
    const stores = [new MikroOrmPoppyStore(handle.orm.em), new MikroOrmPoppyStore(replica.em)];
    const first = stores[0] as MikroOrmPoppyStore;
    await first.createConversation(poppyConversationFixture('cnv_r'));
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        (stores[i % 2] as MikroOrmPoppyStore).appendEvent('cnv_r', {
          type: 'user_requested',
          reason: String(i),
        }),
      ),
    );
    const seqs = (await first.listEvents('cnv_r', 0, 100)).map((e) => e.seq);
    expect(seqs).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
  });
});
