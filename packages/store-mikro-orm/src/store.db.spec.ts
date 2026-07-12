// Integration: MikroOrmAgentStore + ensureAgentSchema against an in-memory SQLite
// (better-sqlite3, via @mikro-orm/sqlite). Runs only under `pnpm test:db`.
import type { StoredMessage, ThreadSummary } from '@dudousxd/nestjs-agent-core';
import { MikroORM, SqliteDriver } from '@mikro-orm/sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentSchemaSql } from './agent-schema-sql';
import { ensureAgentSchema } from './ensure-schema';
import { agentEntities } from './entities';
import { AgentRun } from './entities/agent-run.entity';
import { AgentThread } from './entities/agent-thread.entity';
import { AgentToolCall } from './entities/agent-tool-call.entity';
import { MikroOrmAgentStore } from './mikro-orm-agent-store';
import { MikroOrmPricingStore } from './mikro-orm-pricing-store';

let orm: MikroORM;
let store: MikroOrmAgentStore;

beforeAll(async () => {
  orm = await MikroORM.init({
    driver: SqliteDriver,
    dbName: ':memory:',
    // No collation: SQLite rejects named MySQL collations. Production uses AGENT_ENTITIES.
    entities: agentEntities(),
    allowGlobalContext: true,
  });
  await ensureAgentSchema(orm);
  store = new MikroOrmAgentStore(orm.em);
});

afterAll(async () => {
  await orm?.close(true);
});

describe('MikroOrmAgentStore (sqlite)', () => {
  it('persists threads, messages, tool calls, usage and honours fork/truncate/soft-delete', async () => {
    const today = new Date().toISOString().slice(0, 10);

    // createThread
    const thread = await store.createThread({
      actor: { id: 'actor-1' },
      title: 'My chat',
    });
    expect(thread.id).toBeTruthy();
    expect(thread.title).toBe('My chat');
    expect(thread.transient).toBe(false);

    // appendMessage (user, with an image + PDF attachment)
    const userMessage = await store.appendMessage({
      threadId: thread.id,
      role: 'user',
      content: 'Hello',
      attachments: [
        { mediaId: 'm1', url: 'https://cdn/a.png', contentType: 'image/png', name: 'a.png' },
        { mediaId: 'm2', url: 'https://cdn/b.pdf', contentType: 'application/pdf', name: 'b.pdf' },
      ],
    });
    expect(userMessage.role).toBe('user');
    expect(userMessage.content).toBe('Hello');
    expect(userMessage.attachments).toEqual([
      { mediaId: 'm1', url: 'https://cdn/a.png', contentType: 'image/png', name: 'a.png' },
      { mediaId: 'm2', url: 'https://cdn/b.pdf', contentType: 'application/pdf', name: 'b.pdf' },
    ]);

    // appendMessage (assistant with tool calls + usage + agentName provenance)
    const assistantMessage = await store.appendMessage({
      threadId: thread.id,
      role: 'assistant',
      content: 'Looking that up',
      toolCalls: [{ id: 'tc-1', name: 'lookup', input: { q: 'weather' } }],
      usage: { inputTokens: 10, outputTokens: 5 },
      agentName: 'researcher',
    });
    expect(assistantMessage.toolCalls).toEqual([
      { id: 'tc-1', name: 'lookup', input: { q: 'weather' } },
    ]);
    expect(assistantMessage.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(assistantMessage.agentName).toBe('researcher');

    // recordToolCall (pending) → updateToolCall (executed)
    await store.recordToolCall({
      toolCallId: 'tc-1',
      messageId: assistantMessage.id,
      toolName: 'lookup',
      toolType: 'read',
      input: { q: 'weather' },
      status: 'pending_approval',
      runId: 'run-tc-1',
    });
    await store.updateToolCall({
      toolCallId: 'tc-1',
      status: 'executed',
      output: { result: 'sunny' },
      executionMs: 12,
      executedByRef: 'worker-1',
    });

    const toolCall = await orm.em.fork().findOne(AgentToolCall, { id: 'tc-1' });
    expect(toolCall?.status).toBe('executed');
    expect(toolCall?.output).toEqual({ result: 'sunny' });
    expect(toolCall?.executionMs).toBe(12);
    expect(toolCall?.executedByRef).toBe('worker-1');
    expect(toolCall?.executedAt).toBeInstanceOf(Date);
    // runId round-trips from recordToolCall through to the persisted row
    expect(toolCall?.runId).toBe('run-tc-1');

    // recordToolCall without a runId persists NULL, not undefined — a pre-rollout-shaped call
    await store.recordToolCall({
      toolCallId: 'tc-no-run',
      messageId: assistantMessage.id,
      toolName: 'lookup',
      toolType: 'read',
      input: {},
      status: 'auto_executed',
    });
    const noRunToolCall = await orm.em.fork().findOne(AgentToolCall, { id: 'tc-no-run' });
    expect(noRunToolCall?.runId).toBeNull();

    // ownerOfThread / ownerOfToolCall resolve the owning actorRef for the authz checks
    expect(await store.ownerOfThread(thread.id)).toBe('actor-1');
    expect(await store.ownerOfToolCall('tc-1')).toBe('actor-1');
    expect(await store.ownerOfThread('missing')).toBeNull();
    expect(await store.ownerOfToolCall('missing')).toBeNull();

    // getThread → both messages in order, with tool-call data preserved
    const detail = await store.getThread(thread.id);
    expect(detail).not.toBeNull();
    const messages = detail?.messages as StoredMessage[];
    expect(messages).toHaveLength(2);
    expect(messages[0]?.content).toBe('Hello');
    expect(messages[0]?.attachments).toEqual([
      { mediaId: 'm1', url: 'https://cdn/a.png', contentType: 'image/png', name: 'a.png' },
      { mediaId: 'm2', url: 'https://cdn/b.pdf', contentType: 'application/pdf', name: 'b.pdf' },
    ]);
    expect(messages[1]?.content).toBe('Looking that up');
    expect(messages[1]?.toolCalls?.[0]?.id).toBe('tc-1');
    expect(messages[1]?.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(messages[1]?.agentName).toBe('researcher');
    expect(detail?.lastMessagePreview).toBe('Looking that up');

    // recordUsage twice → quotaToday sums them
    await store.recordUsage({
      threadId: thread.id,
      actorRef: 'actor-1',
      modelId: 'model-x',
      purpose: 'chat',
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    await store.recordUsage({
      threadId: thread.id,
      actorRef: 'actor-1',
      modelId: 'model-x',
      purpose: 'chat',
      usage: { inputTokens: 20, outputTokens: 7 },
      costUsd: 0.0125,
    });
    const quota = await store.quotaToday('actor-1', today);
    expect(quota.usedTokens).toBe(42);
    // costUsd sums only the rows that reported a cost (the first recordUsage had none)
    expect(quota.costUsd).toBeCloseTo(0.0125);
    const otherQuota = await store.quotaToday('actor-2', today);
    expect(otherQuota.usedTokens).toBe(0);
    expect(otherQuota.costUsd).toBe(0);

    // forkThread copies the prefix up to and including the user message
    const fork = await store.forkThread(thread.id, userMessage.id);
    expect(fork.id).not.toBe(thread.id);
    const forkDetail = await store.getThread(fork.id);
    expect(forkDetail?.messages).toHaveLength(1);
    expect(forkDetail?.messages[0]?.content).toBe('Hello');

    // truncateFrom drops the assistant message and onward
    await store.truncateFrom(thread.id, assistantMessage.id);
    const truncated = await store.getThread(thread.id);
    expect(truncated?.messages).toHaveLength(1);
    expect(truncated?.messages[0]?.content).toBe('Hello');
    // tool call attached to the dropped message is gone
    expect(await orm.em.fork().findOne(AgentToolCall, { id: 'tc-1' })).toBeNull();

    // listThreads sees both threads before soft delete
    const before: ThreadSummary[] = await store.listThreads('actor-1');
    expect(before.map((t) => t.id).sort()).toEqual([thread.id, fork.id].sort());

    // softDeleteThread → getThread null + excluded from listThreads
    await store.softDeleteThread(thread.id);
    expect(await store.getThread(thread.id)).toBeNull();
    const after = await store.listThreads('actor-1');
    expect(after.map((t) => t.id)).toEqual([fork.id]);
  });

  it('resolves the owning actorRef for an active stream by runId', async () => {
    const thread = await store.createThread({ actor: { id: 'actor-stream' } });
    await store.setActiveStream(thread.id, 'run-xyz');

    expect(await store.ownerOfActiveStream('run-xyz')).toBe('actor-stream');
    expect(await store.ownerOfActiveStream('missing')).toBeNull();
  });

  it('activeRunForThread reads the same activeStreamId setActiveStream writes', async () => {
    const thread = await store.createThread({ actor: { id: 'actor-active' } });
    expect(await store.activeRunForThread(thread.id)).toBeNull();

    await store.setActiveStream(thread.id, 'run-abc');
    expect(await store.activeRunForThread(thread.id)).toBe('run-abc');

    await store.setActiveStream(thread.id, null);
    expect(await store.activeRunForThread(thread.id)).toBeNull();

    expect(await store.activeRunForThread('missing')).toBeNull();
  });

  it('updateThread patches title and/or defaultAgent, leaving omitted fields untouched', async () => {
    const thread = await store.createThread({ actor: { id: 'actor-update' }, title: 'Original' });
    const readDefaultAgent = async () =>
      (await orm.em.fork().findOne(AgentThread, { id: thread.id }))?.defaultAgent;

    // title only — defaultAgent stays unset (NULL, since it was never set on create)
    await store.updateThread(thread.id, { title: 'Renamed' });
    expect((await store.getThread(thread.id))?.title).toBe('Renamed');
    expect(await readDefaultAgent()).toBeNull();

    // defaultAgent only — title from the previous patch is preserved
    await store.updateThread(thread.id, { defaultAgent: 'researcher' });
    expect((await store.getThread(thread.id))?.title).toBe('Renamed');
    expect(await readDefaultAgent()).toBe('researcher');

    // explicit null clears defaultAgent
    await store.updateThread(thread.id, { defaultAgent: null });
    expect(await readDefaultAgent()).toBeNull();

    // both fields in one patch
    await store.updateThread(thread.id, { title: 'Both', defaultAgent: 'billing-agent' });
    expect((await store.getThread(thread.id))?.title).toBe('Both');
    expect(await readDefaultAgent()).toBe('billing-agent');

    // unknown thread is a silent no-op
    await expect(store.updateThread('missing', { title: 'x' })).resolves.toBeUndefined();
  });

  it('promotes a transient thread so it surfaces in listThreads', async () => {
    const transient = await store.createThread({ actor: { id: 'actor-p' }, transient: true });
    expect(transient.transient).toBe(true);
    // a transient thread is hidden from history until promoted
    expect(await store.listThreads('actor-p')).toHaveLength(0);

    await store.promoteThread(transient.id);
    const listed = await store.listThreads('actor-p');
    expect(listed.map((t) => t.id)).toEqual([transient.id]);
    expect(listed[0]?.transient).toBe(false);

    // idempotent: promoting an already-persistent thread is a no-op
    await store.promoteThread(transient.id);
    expect(await store.listThreads('actor-p')).toHaveLength(1);
  });

  it('records a run start/end and bumps retries atomically', async () => {
    const thread = await store.createThread({ actor: { id: 'actor-run' } });

    await store.recordRunStart({
      runId: 'run-1',
      threadId: thread.id,
      actorRef: 'actor-run',
      agentName: 'researcher',
      promptHash: 'abc123def456',
    });
    const started = await orm.em.fork().findOne(AgentRun, { id: 'run-1' });
    expect(started?.status).toBe('running');
    expect(started?.retries).toBe(0);
    expect(started?.agentName).toBe('researcher');
    expect(started?.settledAt).toBeNull();
    expect(started?.promptHash).toBe('abc123def456');

    // bumpRunRetries increments without a read-modify-write race (nativeUpdate `retries + 1`)
    await store.bumpRunRetries('run-1');
    await store.bumpRunRetries('run-1');
    const bumped = await orm.em.fork().findOne(AgentRun, { id: 'run-1' });
    expect(bumped?.retries).toBe(2);

    await store.recordRunEnd({
      runId: 'run-1',
      status: 'completed',
      durationMs: 1_234,
    });
    const settled = await orm.em.fork().findOne(AgentRun, { id: 'run-1' });
    expect(settled?.status).toBe('completed');
    expect(settled?.durationMs).toBe(1_234);
    expect(settled?.settledAt).toBeInstanceOf(Date);
    expect(settled?.errorCode).toBeNull();

    // a run with no agentName defaults to null, and a failed run carries the error fields
    await store.recordRunStart({ runId: 'run-2', threadId: thread.id, actorRef: 'actor-run' });
    await store.recordRunEnd({
      runId: 'run-2',
      status: 'failed',
      errorCode: 'timeout',
      errorMessage: 'upstream timed out',
    });
    const failed = await orm.em.fork().findOne(AgentRun, { id: 'run-2' });
    expect(failed?.agentName).toBeNull();
    expect(failed?.status).toBe('failed');
    expect(failed?.errorCode).toBe('timeout');
    expect(failed?.errorMessage).toBe('upstream timed out');
    // a run started with no promptHash defaults to null
    expect(failed?.promptHash).toBeNull();

    // recordRunEnd/bumpRunRetries on an unknown run are silent no-ops
    await expect(
      store.recordRunEnd({ runId: 'missing', status: 'completed' }),
    ).resolves.toBeUndefined();
    await expect(store.bumpRunRetries('missing')).resolves.toBeUndefined();
  });

  it('supersedes the current price row on upsert, keeping exactly one current row per model', async () => {
    const pricingStore = new MikroOrmPricingStore(orm.em);

    await pricingStore.upsertModelPrice({
      modelId: 'm',
      inputPricePer1m: 3,
      outputPricePer1m: 15,
    });
    const firstPrices = await pricingStore.listCurrentPrices();
    const first = firstPrices.filter((price) => price.modelId === 'm');
    expect(first).toHaveLength(1);
    expect(first[0]?.inputPricePer1m).toBe(3);
    expect(first[0]?.outputPricePer1m).toBe(15);

    await pricingStore.upsertModelPrice({
      modelId: 'm',
      inputPricePer1m: 4,
      outputPricePer1m: 16,
    });
    const secondPrices = await pricingStore.listCurrentPrices();
    const second = secondPrices.filter((price) => price.modelId === 'm');
    expect(second).toHaveLength(1);
    expect(second[0]?.inputPricePer1m).toBe(4);
    expect(second[0]?.outputPricePer1m).toBe(16);
  });
});

describe('ensureAgentSchema (fingerprint-gated autoSchema)', () => {
  it('creates the agent tables + marker on a fresh DB and no-ops on the second call', async () => {
    const fresh = await MikroORM.init({
      driver: SqliteDriver,
      dbName: ':memory:',
      entities: agentEntities(),
      allowGlobalContext: true,
    });
    try {
      await ensureAgentSchema(fresh);
      // marker row written with the applied fingerprint
      const first = await fresh.em
        .getConnection()
        .execute<{ fingerprint: string }[]>(
          "select fingerprint from agent_schema_meta where id = 'agent'",
        );
      expect(first[0]?.fingerprint).toMatch(/^[a-f0-9]{64}$/);

      // the store works against the auto-created schema
      const store = new MikroOrmAgentStore(fresh.em);
      const thread = await store.createThread({ actor: { id: 'a' }, title: 'auto' });
      expect((await store.getThread(thread.id))?.title).toBe('auto');

      // second call is a no-op (fingerprint matches) — same marker, no throw from re-created indexes
      await ensureAgentSchema(fresh);
      const second = await fresh.em
        .getConnection()
        .execute<{ fingerprint: string }[]>(
          "select fingerprint from agent_schema_meta where id = 'agent'",
        );
      expect(second[0]?.fingerprint).toBe(first[0]?.fingerprint);
    } finally {
      await fresh.close(true);
    }
  });
});

describe('agentSchemaSql', () => {
  it('renders create-only DDL for the six agent tables, applying `if not exists` to tables', async () => {
    const statements = await agentSchemaSql(orm);
    const joined = statements.join('\n');
    for (const table of [
      'agent_thread',
      'agent_message',
      'agent_tool_call',
      'agent_token_usage',
      'agent_model_pricing',
      'agent_run',
    ]) {
      expect(joined).toContain(table);
    }
    const creates = statements.filter((sql) => /^create table/i.test(sql));
    expect(creates).toHaveLength(6);
    // every create table is guarded; indexes stay plain (MySQL has no `create index if not exists`)
    expect(creates.every((sql) => /^create table if not exists/i.test(sql))).toBe(true);
    expect(statements.some((sql) => /^create index/i.test(sql))).toBe(true);
  });

  it('opts out of `if not exists` when asked, and the statements build a working schema', async () => {
    const statements = await agentSchemaSql(orm, { ifNotExists: false });
    expect(statements.every((sql) => !/if not exists/i.test(sql))).toBe(true);

    // Apply the generated DDL against an isolated database and confirm the store works on it.
    const fresh = await MikroORM.init({
      driver: SqliteDriver,
      dbName: ':memory:',
      entities: agentEntities(),
      allowGlobalContext: true,
    });
    try {
      for (const sql of await agentSchemaSql(fresh, { ifNotExists: false })) {
        await fresh.em.getConnection().execute(sql);
      }
      const freshStore = new MikroOrmAgentStore(fresh.em);
      const thread = await freshStore.createThread({ actor: { id: 'a' }, title: 'built' });
      expect((await freshStore.getThread(thread.id))?.title).toBe('built');
    } finally {
      await fresh.close(true);
    }
  });
});
