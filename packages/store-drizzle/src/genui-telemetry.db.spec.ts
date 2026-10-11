// Integration: generative-UI telemetry (`recordGenuiCalls` / `genuiStats`) on SQLite, Postgres and
// MySQL. Runs only under `pnpm test:db`.
import type { RecordGenuiCallInput } from '@dudousxd/nestjs-agent-core';
import { GENUI_TELEMETRY_STORE_CONTRACT } from '@dudousxd/nestjs-agent-testing';
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

describeEachDialect('agent_genui_call — the generative-UI telemetry contract', (dialect) => {
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
    const actorRef = 'genui-actor';
    const thread = await store.createThread({ actor: { id: actorRef } });
    return { store, governance, threadId: thread.id, actorRef };
  }

  for (const contractCase of GENUI_TELEMETRY_STORE_CONTRACT) {
    it(contractCase.name, async () => contractCase.run(await subject()));
  }

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

  it('keeps a sampled payload and stores NULL for an unsampled one', async () => {
    const { threadId } = await subject();
    const payload = JSON.stringify({ code: 'export function App() {}' });
    await store.recordGenuiCalls([
      row(threadId, { toolCallId: 'sampled', payload }),
      row(threadId, { toolCallId: 'unsampled' }),
    ]);

    const rows = await handle.rows<{ id: string; payload: string | null }>(
      'select id, payload from agent_genui_call order by id',
    );
    expect(rows).toEqual([
      { id: 'sampled', payload },
      { id: 'unsampled', payload: null },
    ]);
  });

  it('cascades a deleted thread to its rows', async () => {
    const { threadId } = await subject();
    await store.recordGenuiCalls([row(threadId, { toolCallId: 'cascaded' })]);
    await handle.run(`delete from agent_thread where id = '${threadId}'`);
    expect(await handle.rows('select id from agent_genui_call')).toEqual([]);
  });

  it('heals a database that predates the table: creates it with its indexes', async () => {
    await handle.run('DROP TABLE agent_genui_call');
    expect(await columnsOf(handle, 'agent_genui_call')).toEqual([]);

    await ensureAgentSchema(handle.db);

    expect(await columnsOf(handle, 'agent_genui_call')).toContain('payload');
    const indexes = await indexesOf(handle, 'agent_genui_call');
    expect(indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining(['agent_genui_call_created_idx', 'agent_genui_call_run_idx']),
    );
    const { threadId } = await subject();
    await store.recordGenuiCalls([row(threadId, { toolCallId: 'after-heal' })]);
    const today = new Date().toISOString().slice(0, 10);
    expect((await governance.genuiStats({ fromDay: today, toDay: today })).totals.calls).toBe(1);
  });
});
