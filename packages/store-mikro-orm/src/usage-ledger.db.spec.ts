// Integration: the usage ledger beyond agent turns and the run timings, on SQLite, Postgres and
// MySQL. Runs only under `pnpm test:db`.
import { USAGE_LEDGER_STORE_CONTRACT } from '@dudousxd/nestjs-agent-testing';
import type { MikroORM } from '@mikro-orm/core';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { agentSchemaSql } from './agent-schema-sql';
import { ensureAgentSchema } from './ensure-schema';
import { MikroOrmAgentStore } from './mikro-orm-agent-store';
import { MikroOrmGovernanceQueries } from './mikro-orm-governance-queries';
import { MikroOrmPricingStore } from './mikro-orm-pricing-store';
import {
  type AgentOrmHandle,
  columnsOf,
  describeEachDialect,
  indexesOf,
  openAgentOrm,
  openFreshOrm,
  rawSql,
} from './testing/real-db';

describeEachDialect(
  'agent_token_usage / agent_run — the usage ledger and run timings',
  (dialect) => {
    let handle: AgentOrmHandle;
    let store: MikroOrmAgentStore;
    let governance: MikroOrmGovernanceQueries;
    const opened: MikroORM[] = [];

    beforeAll(async () => {
      handle = await openAgentOrm(dialect);
      store = new MikroOrmAgentStore(handle.orm.em);
      governance = new MikroOrmGovernanceQueries(
        handle.orm.em,
        new MikroOrmPricingStore(handle.orm.em),
      );
    });

    afterAll(async () => {
      await handle?.close();
    });

    beforeEach(async () => {
      await rawSql(handle.orm, 'delete from agent_token_usage');
      await rawSql(handle.orm, 'delete from agent_run');
    });

    afterEach(async () => {
      for (const instance of opened.splice(0)) await instance.close(true);
    });

    async function subject() {
      const actorRef = 'ledger-actor';
      const thread = await store.createThread({ actor: { id: actorRef } });
      return { store, governance, threadId: thread.id, actorRef };
    }

    for (const contractCase of USAGE_LEDGER_STORE_CONTRACT) {
      it(contractCase.name, async () => contractCase.run(await subject()));
    }

    it('heals an install whose ledger has thread_id NOT NULL: relaxes it, keeps rows and the cascade', async () => {
      const instance = await openFreshOrm(dialect);
      opened.push(instance);
      for (const statement of await agentSchemaSql(instance, { ifNotExists: false })) {
        await rawSql(instance, statement);
      }
      await ensureAgentSchema(instance);
      const healed = new MikroOrmAgentStore(instance.em);
      const thread = await healed.createThread({ actor: { id: 'ledger-actor' } });
      const usage = { inputTokens: 3, outputTokens: 2 };
      await healed.recordUsage({
        threadId: thread.id,
        actorRef: 'ledger-actor',
        modelId: 'm',
        purpose: 'chat',
        usage,
      });
      // The ledger as an install from before usage without a thread has it.
      if (dialect === 'postgres') {
        await rawSql(
          instance,
          'alter table "agent_token_usage" alter column "thread_id" set not null',
        );
      } else if (dialect === 'mysql') {
        // Its own type and collation, read back: the foreign key needs them to match agent_thread.id.
        const [column] = (await rawSql<{ type: string; collation: string | null }[]>(
          instance,
          "select column_type as type, collation_name as collation from information_schema.columns where table_schema = database() and table_name = 'agent_token_usage' and column_name = 'thread_id'",
        )) as { type: string; collation: string | null }[];
        const collate = column?.collation ? ` collate ${column.collation}` : '';
        await rawSql(
          instance,
          `alter table \`agent_token_usage\` modify \`thread_id\` ${column?.type}${collate} not null`,
        );
      } else {
        const [create] = (await rawSql<{ sql: string }[]>(
          instance,
          "select sql from sqlite_master where type = 'table' and name = 'agent_token_usage'",
        )) as { sql: string }[];
        const legacy = String(create?.sql)
          .replace('CREATE TABLE `agent_token_usage`', 'CREATE TABLE `agent_token_usage_legacy`')
          .replace(/`thread_id` text( null)?/i, '`thread_id` text not null');
        await rawSql(instance, legacy);
        await rawSql(
          instance,
          'insert into agent_token_usage_legacy select * from agent_token_usage',
        );
        await rawSql(instance, 'drop table agent_token_usage');
        await rawSql(instance, 'alter table agent_token_usage_legacy rename to agent_token_usage');
      }
      await rawSql(instance, "update agent_schema_meta set fingerprint = 'older-release'");
      await expect(
        healed.recordUsage({ actorRef: 'ledger-actor', modelId: 'm', purpose: 'external', usage }),
      ).rejects.toThrow();

      await ensureAgentSchema(instance);

      expect(await columnsOf(instance, 'agent_token_usage')).toEqual(
        expect.arrayContaining(['feature', 'audio_seconds', 'metadata']),
      );
      await healed.recordUsage({
        actorRef: 'ledger-actor',
        modelId: 'whisper-1',
        purpose: 'external',
        feature: 'transcription',
        usage: { inputTokens: 0, outputTokens: 0 },
        audioSeconds: 30,
      });
      expect(await rawSql<unknown[]>(instance, 'select id from agent_token_usage')).toHaveLength(2);
      expect((await indexesOf(instance, 'agent_token_usage')).map((index) => index.name)).toEqual(
        expect.arrayContaining(['agent_token_usage_feature_created_idx']),
      );
      await rawSql(instance, 'delete from agent_thread where id = ?', [thread.id]);
      expect(await rawSql<unknown[]>(instance, 'select id from agent_token_usage')).toHaveLength(1);
    });
  },
);
