// Integration: the usage ledger beyond agent turns and the run timings, on SQLite, Postgres and
// MySQL. Runs only under `pnpm test:db`.
import { USAGE_LEDGER_STORE_CONTRACT } from '@dudousxd/nestjs-agent-testing';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { DrizzleAgentStore } from './drizzle-agent-store.js';
import { DrizzleGovernanceQueries } from './drizzle-governance-queries.js';
import { DrizzlePricingStore } from './drizzle-pricing-store.js';
import { ensureAgentSchema } from './ensure-schema.js';
import {
  type AgentDbHandle,
  columnsOf,
  describeEachDialect,
  indexesOf,
  openAgentDb,
} from './testing/real-db.js';

describeEachDialect(
  'agent_token_usage / agent_run — the usage ledger and run timings',
  (dialect) => {
    let handle: AgentDbHandle;
    let store: DrizzleAgentStore;
    let governance: DrizzleGovernanceQueries;

    beforeAll(async () => {
      handle = await openAgentDb(dialect);
      store = new DrizzleAgentStore(handle.db);
      governance = new DrizzleGovernanceQueries(handle.db, new DrizzlePricingStore(handle.db));
    });

    afterAll(async () => {
      await handle?.close();
    });

    beforeEach(async () => {
      await handle.reset();
    });

    async function subject() {
      const actorRef = 'ledger-actor';
      const thread = await store.createThread({ actor: { id: actorRef } });
      return { store, governance, threadId: thread.id, actorRef };
    }

    for (const contractCase of USAGE_LEDGER_STORE_CONTRACT) {
      it(contractCase.name, async () => contractCase.run(await subject()));
    }

    it('heals a ledger whose thread_id is NOT NULL: relaxes it, keeps rows, indexes and the cascade', async () => {
      const { threadId, actorRef } = await subject();
      const other = await store.createThread({ actor: { id: actorRef } });
      const usage = { inputTokens: 3, outputTokens: 2 };
      await store.recordUsage({ threadId, actorRef, modelId: 'm', purpose: 'chat', usage });
      await store.recordUsage({
        threadId: other.id,
        actorRef,
        modelId: 'm',
        purpose: 'chat',
        usage,
      });
      // The ledger as a database provisioned before usage could be recorded without a thread has it.
      if (dialect === 'postgres') {
        await handle.run('ALTER TABLE "agent_token_usage" ALTER COLUMN "thread_id" SET NOT NULL');
      } else if (dialect === 'mysql') {
        await handle.run(
          'ALTER TABLE `agent_token_usage` MODIFY `thread_id` varchar(255) NOT NULL',
        );
      } else {
        await handle.run('ALTER TABLE "agent_token_usage" RENAME TO "agent_token_usage_old"');
        await handle.run(
          'CREATE TABLE "agent_token_usage" ("id" text PRIMARY KEY NOT NULL, "thread_id" text NOT NULL, ' +
            '"actor_ref" text NOT NULL, "message_id" text, "model_id" text NOT NULL, "purpose" text NOT NULL, ' +
            '"input_tokens" integer NOT NULL, "output_tokens" integer NOT NULL, "cache_write_tokens" integer, ' +
            '"cache_read_tokens" integer, "cost_usd" real, "cost_source" text, "created_at" integer NOT NULL, ' +
            'FOREIGN KEY ("thread_id") REFERENCES "agent_thread" ("id") ON DELETE CASCADE)',
        );
        await handle.run(
          'INSERT INTO "agent_token_usage" SELECT "id", "thread_id", "actor_ref", "message_id", "model_id", ' +
            '"purpose", "input_tokens", "output_tokens", "cache_write_tokens", "cache_read_tokens", "cost_usd", ' +
            '"cost_source", "created_at" FROM "agent_token_usage_old"',
        );
        await handle.run('DROP TABLE "agent_token_usage_old"');
        expect(await columnsOf(handle, 'agent_token_usage')).not.toContain('feature');
      }
      await expect(
        store.recordUsage({ actorRef, modelId: 'm', purpose: 'external', usage }),
      ).rejects.toThrow();

      await ensureAgentSchema(handle.db);

      expect(await columnsOf(handle, 'agent_token_usage')).toEqual(
        expect.arrayContaining(['feature', 'audio_seconds', 'metadata', 'run_id']),
      );
      await store.recordUsage({
        actorRef,
        modelId: 'whisper-1',
        purpose: 'external',
        feature: 'transcription',
        usage: { inputTokens: 0, outputTokens: 0 },
        audioSeconds: 30,
      });
      expect(await handle.rows('select id from agent_token_usage')).toHaveLength(3);
      expect((await indexesOf(handle, 'agent_token_usage')).map((index) => index.name)).toEqual(
        expect.arrayContaining([
          'agent_token_usage_actor_created_idx',
          'agent_token_usage_feature_created_idx',
        ]),
      );
      // The foreign key survived: a deleted thread still takes its rows with it.
      await handle.run(`delete from agent_thread where id = '${threadId}'`);
      expect(await handle.rows('select id from agent_token_usage')).toHaveLength(2);
      // Current now: a second heal changes nothing and the rows stay.
      await ensureAgentSchema(handle.db);
      expect(await handle.rows('select id from agent_token_usage')).toHaveLength(2);
    });
  },
);
