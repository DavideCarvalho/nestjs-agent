// Integration: DrizzleConfirmTokenStore on SQLite, Postgres and MySQL. Runs only under `pnpm test:db`.
import { AGENT_CONFIRM_TOKEN_STORE } from '@dudousxd/nestjs-agent-core';
import { CONFIRM_TOKEN_STORE_CONTRACT } from '@dudousxd/nestjs-agent-testing';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleAgentStoreModule } from './drizzle-agent-store.module.js';
import { DrizzleConfirmTokenStore } from './drizzle-confirm-token-store.js';
import { agentSchema } from './schema.js';
import { type AgentDbHandle, describeEachDialect, openAgentDb } from './testing/real-db.js';

describeEachDialect('DrizzleConfirmTokenStore — the confirm-token store contract', (dialect) => {
  let handle: AgentDbHandle;

  beforeAll(async () => {
    handle = await openAgentDb(dialect);
  });

  afterAll(async () => {
    await handle?.close();
  });

  async function fresh() {
    await handle.run('delete from agent_confirm_token');
    return {
      store: new DrizzleConfirmTokenStore(handle.db),
      rows: async () =>
        (await handle.q.select().from(handle.t.agentConfirmToken)) as Record<string, unknown>[],
    };
  }

  for (const contractCase of CONFIRM_TOKEN_STORE_CONTRACT) {
    it(contractCase.name, async () => contractCase.run(await fresh()));
  }
});

describe('DrizzleAgentStoreModule', () => {
  it('binds the confirm-token store for confirmed tools to inject', () => {
    const db = drizzle(new Database(':memory:'), { schema: agentSchema });
    const module = DrizzleAgentStoreModule.forRoot({ db, ragIngestionLog: false });
    expect(module.exports).toContain(AGENT_CONFIRM_TOKEN_STORE);
    const provider = module.providers?.find(
      (entry) => typeof entry === 'object' && entry.provide === AGENT_CONFIRM_TOKEN_STORE,
    );
    expect(provider).toMatchObject({ useExisting: DrizzleConfirmTokenStore });
  });
});
