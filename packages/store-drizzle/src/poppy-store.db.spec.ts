// Integration: DrizzlePoppyStore / DrizzlePoppyConnectionStore on SQLite, Postgres and MySQL. Runs
// only under `pnpm test:db`.
import {
  AGENT_POPPY_CONNECTION_STORE,
  AGENT_POPPY_STORE,
  POPPY_CONNECTION_TABLES,
  POPPY_TABLES,
} from '@dudousxd/nestjs-agent-core';
import {
  POPPY_CONNECTION_STORE_CONTRACT,
  POPPY_STORE_CONTRACT,
} from '@dudousxd/nestjs-agent-testing';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleAgentStoreModule } from './drizzle-agent-store.module.js';
import { DrizzlePoppyConnectionStore } from './drizzle-poppy-connection-store.js';
import { DrizzlePoppyStore } from './drizzle-poppy-store.js';
import { agentSchema } from './schema.js';
import {
  type AgentDbHandle,
  columnsOf,
  describeEachDialect,
  indexesOf,
  openAgentDb,
} from './testing/real-db.js';

const ALL_TABLES = [...Object.values(POPPY_TABLES), ...Object.values(POPPY_CONNECTION_TABLES)];

describeEachDialect('Drizzle Poppy stores', (dialect) => {
  let handle: AgentDbHandle;

  beforeAll(async () => {
    handle = await openAgentDb(dialect);
  });

  afterAll(async () => {
    await handle?.close();
  });

  async function clear() {
    for (const table of ALL_TABLES) await handle.run(`delete from ${table}`);
  }

  describe('the Poppy store contract', () => {
    for (const contractCase of POPPY_STORE_CONTRACT) {
      it(contractCase.name, async () => {
        await clear();
        await contractCase.run({ store: new DrizzlePoppyStore(handle.db) });
      });
    }
  });

  describe('the Poppy connection store contract', () => {
    for (const contractCase of POPPY_CONNECTION_STORE_CONTRACT) {
      it(contractCase.name, async () => {
        await clear();
        await contractCase.run({ store: new DrizzlePoppyConnectionStore(handle.db) });
      });
    }
  });

  it('creates the Poppy tables at boot, keyed for the races', async () => {
    for (const table of ALL_TABLES) {
      expect((await columnsOf(handle, table)).length).toBeGreaterThan(0);
    }
    const indexes = await indexesOf(handle, POPPY_TABLES.events);
    expect(indexes).toEqual(
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
    if (dialect === 'sqlite') return; // one in-memory connection: no second replica
    await clear();
    const replica = await handle.replica();
    const stores = [new DrizzlePoppyStore(handle.db), new DrizzlePoppyStore(replica)];
    const first = stores[0] as DrizzlePoppyStore;
    await first.createConversation({
      id: 'cnv_r',
      clientId: 'https://pa.example',
      userId: 'u1',
      accountRef: null,
      agentName: 'support',
      threadId: null,
      parentId: null,
      openDirectId: null,
      status: 'idle',
      responder: 'agent',
      context: {},
      activeRunId: null,
      turnSeq: 0,
      grant: null,
      prunedSeq: 0,
      createdAt: 1,
      updatedAt: 1,
    });
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        (stores[i % 2] as DrizzlePoppyStore).appendEvent('cnv_r', {
          type: 'user_requested',
          reason: String(i),
        }),
      ),
    );
    const seqs = (await first.listEvents('cnv_r', 0, 100)).map((e) => e.seq);
    expect(seqs).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
  });
});

describe('DrizzleAgentStoreModule', () => {
  it('binds the Poppy stores', () => {
    const db = drizzle(new Database(':memory:'), { schema: agentSchema });
    const module = DrizzleAgentStoreModule.forRoot({ db, ragIngestionLog: false });
    expect(module.exports).toEqual(
      expect.arrayContaining([AGENT_POPPY_STORE, AGENT_POPPY_CONNECTION_STORE]),
    );
    const bound = (token: symbol) =>
      module.providers?.find((entry) => typeof entry === 'object' && entry.provide === token);
    expect(bound(AGENT_POPPY_STORE)).toMatchObject({ useExisting: DrizzlePoppyStore });
    expect(bound(AGENT_POPPY_CONNECTION_STORE)).toMatchObject({
      useExisting: DrizzlePoppyConnectionStore,
    });
  });
});
