// Integration: DrizzleChannelStore on SQLite, Postgres and MySQL. Runs only under `pnpm test:db`.
import { AGENT_CHANNEL_STORE } from '@dudousxd/nestjs-agent-core';
import { CHANNEL_STORE_CONTRACT } from '@dudousxd/nestjs-agent-testing';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleAgentStoreModule } from './drizzle-agent-store.module.js';
import { DrizzleChannelStore } from './drizzle-channel-store.js';
import { agentSchema } from './schema.js';
import { type AgentDbHandle, describeEachDialect, openAgentDb } from './testing/real-db.js';

describeEachDialect('DrizzleChannelStore — the channel store contract', (dialect) => {
  let handle: AgentDbHandle;

  beforeAll(async () => {
    handle = await openAgentDb(dialect);
  });

  afterAll(async () => {
    await handle?.close();
  });

  async function fresh() {
    await handle.run('delete from agent_channel_state');
    return { store: new DrizzleChannelStore(handle.db) };
  }

  for (const contractCase of CHANNEL_STORE_CONTRACT) {
    it(contractCase.name, async () => contractCase.run(await fresh()));
  }
});

describe('DrizzleAgentStoreModule', () => {
  it('binds the channel store for text channels', () => {
    const db = drizzle(new Database(':memory:'), { schema: agentSchema });
    const module = DrizzleAgentStoreModule.forRoot({ db, ragIngestionLog: false });
    expect(module.exports).toContain(AGENT_CHANNEL_STORE);
    const provider = module.providers?.find(
      (entry) => typeof entry === 'object' && entry.provide === AGENT_CHANNEL_STORE,
    );
    expect(provider).toMatchObject({ useExisting: DrizzleChannelStore });
  });
});
