// Integration: generative-UI telemetry (`recordGenuiCalls` / `genuiStats`) on SQLite, Postgres and
// MySQL. Runs only under `pnpm test:db`.
import type { RecordGenuiCallInput } from '@dudousxd/nestjs-agent-core';
import { GENUI_TELEMETRY_STORE_CONTRACT } from '@dudousxd/nestjs-agent-testing';
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

const today = () => new Date().toISOString().slice(0, 10);

function row(threadId: string, overrides: Partial<RecordGenuiCallInput>): RecordGenuiCallInput {
  return {
    toolCallId: 'call',
    runId: 'run-payload',
    threadId,
    actorRef: 'genui-actor',
    step: 0,
    toolName: 'ui__sandbox',
    channel: 'web',
    mode: 'sandbox',
    modelId: 'model-a',
    attempt: 1,
    outcome: 'ok',
    validity: 'first_try',
    inputTokens: 1,
    outputTokens: 1,
    payloadBytes: 10,
    ...overrides,
  };
}

describeEachDialect('agent_genui_call — the generative-UI telemetry contract', (dialect) => {
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
    await rawSql(handle.orm, 'delete from agent_genui_call');
  });

  afterEach(async () => {
    for (const instance of opened.splice(0)) await instance.close(true);
  });

  async function subject() {
    const actorRef = 'genui-actor';
    const thread = await store.createThread({ actor: { id: actorRef } });
    return { store, governance, threadId: thread.id, actorRef };
  }

  for (const contractCase of GENUI_TELEMETRY_STORE_CONTRACT) {
    it(contractCase.name, async () => contractCase.run(await subject()));
  }

  it('keeps a sampled payload and stores NULL for an unsampled one', async () => {
    const { threadId } = await subject();
    const payload = JSON.stringify({ code: 'export function App() {}' });
    await store.recordGenuiCalls([
      row(threadId, { toolCallId: 'sampled', payload }),
      row(threadId, { toolCallId: 'unsampled' }),
    ]);

    const rows: { id: string; payload: string | null }[] = await rawSql(
      handle.orm,
      'select id, payload from agent_genui_call order by id',
    );
    expect(rows.map(({ id, payload }) => ({ id, payload }))).toEqual([
      { id: 'sampled', payload },
      { id: 'unsampled', payload: null },
    ]);
  });

  it('cascades a deleted thread to its rows', async () => {
    const { threadId } = await subject();
    await store.recordGenuiCalls([row(threadId, { toolCallId: 'cascaded' })]);
    await rawSql(handle.orm, 'delete from agent_thread where id = ?', [threadId]);
    expect(await rawSql(handle.orm, 'select id from agent_genui_call')).toEqual([]);
  });

  it('heals an install that predates the table: creates it with its indexes', async () => {
    const instance = await openFreshOrm(dialect);
    opened.push(instance);
    // An older install: every other agent table, already healed under an older fingerprint.
    for (const statement of await agentSchemaSql(instance, { ifNotExists: false })) {
      if (!statement.includes('agent_genui_call')) await rawSql(instance, statement);
    }
    await ensureAgentSchema(instance);
    await rawSql(instance, 'drop table agent_genui_call');
    await rawSql(instance, "update agent_schema_meta set fingerprint = 'older-release'");
    expect(await columnsOf(instance, 'agent_genui_call')).toEqual([]);

    await ensureAgentSchema(instance);

    expect(await columnsOf(instance, 'agent_genui_call')).toEqual(
      expect.arrayContaining(['id', 'run_id', 'thread_id', 'payload', 'created_at']),
    );
    expect((await indexesOf(instance, 'agent_genui_call')).map((index) => index.name)).toEqual(
      expect.arrayContaining(['agent_genui_call_created_idx', 'agent_genui_call_run_idx']),
    );
    const healed = new MikroOrmAgentStore(instance.em);
    const thread = await healed.createThread({ actor: { id: 'genui-actor' } });
    await healed.recordGenuiCalls([row(thread.id, { toolCallId: 'after-heal' })]);
    const stats = await new MikroOrmGovernanceQueries(
      instance.em,
      new MikroOrmPricingStore(instance.em),
    ).genuiStats({ fromDay: today(), toDay: today() });
    expect(stats.totals.calls).toBe(1);
  });
});
