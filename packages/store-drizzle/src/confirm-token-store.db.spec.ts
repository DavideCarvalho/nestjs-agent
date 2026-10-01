// Integration: DrizzleConfirmTokenStore against an in-memory SQLite. Runs only under `pnpm test:db`.
import { AGENT_CONFIRM_TOKEN_STORE } from '@dudousxd/nestjs-agent-core';
import { CONFIRM_TOKEN_STORE_CONTRACT } from '@dudousxd/nestjs-agent-testing';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, expect, it } from 'vitest';
import { DrizzleAgentStoreModule } from './drizzle-agent-store.module.js';
import { DrizzleConfirmTokenStore } from './drizzle-confirm-token-store.js';
import { ensureAgentSchema } from './ensure-schema.js';
import { agentConfirmToken, agentSchema } from './schema.js';

async function fresh() {
  const db = drizzle(new Database(':memory:'), { schema: agentSchema });
  await ensureAgentSchema(db);
  return {
    store: new DrizzleConfirmTokenStore(db),
    rows: async () => (await db.select().from(agentConfirmToken)) as Record<string, unknown>[],
  };
}

describe('DrizzleConfirmTokenStore — the confirm-token store contract', () => {
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
