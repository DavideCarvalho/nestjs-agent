// Integration: MikroOrmAgentStore + ensureAgentSchema against an in-memory SQLite
// (better-sqlite3, via @mikro-orm/sqlite). Runs only under `pnpm test:db`.
import type {
  RecordRunEndInput,
  RecordRunStartInput,
  StoredMessage,
  ThreadSummary,
  UpdateThreadInput,
} from '@dudousxd/nestjs-agent-core';
import { EVERY_MESSAGE_FIELD } from '@dudousxd/nestjs-agent-testing';
import { MikroORM, SqliteDriver } from '@mikro-orm/sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentSchemaSql } from './agent-schema-sql';
import { agentManagedTables, ensureAgentSchema } from './ensure-schema';
import { agentEntities } from './entities';
import { AgentMessage } from './entities/agent-message.entity';
import { AgentRun, type AgentRunStatus } from './entities/agent-run.entity';
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
  it('renders create-only DDL for every managed table, applying `if not exists` to tables', async () => {
    const statements = await agentSchemaSql(orm);
    const joined = statements.join('\n');
    for (const table of [
      'agent_thread',
      'agent_message',
      'agent_tool_call',
      'agent_token_usage',
      'agent_model_pricing',
      'agent_run',
      'rag_ingestion_log',
    ]) {
      expect(joined).toContain(table);
    }
    const creates = statements.filter((sql) => /^create table/i.test(sql));
    // pinned to the managed-table set, so adding an entity without updating it can't slip through
    expect(creates).toHaveLength(agentManagedTables().length);
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

describe('MikroOrmAgentStore — a turn a client reads back', () => {
  it('pairs every tool call on a message with the result the turn settled it with', async () => {
    const thread = await store.createThread({ actor: { id: 'actor-1' } });
    const message = await store.appendMessage({
      threadId: thread.id,
      role: 'assistant',
      content: 'looking',
      toolCalls: [
        { id: 'c1', name: 'lookup', input: {}, kind: 'read' },
        { id: 'c2', name: 'retrieve', input: { query: 'refunds' }, kind: 'read' },
      ],
      toolResults: [{ id: 'c2', name: 'retrieve', output: { passages: [] } }],
    });

    await store.setMessageToolResults(message.id, [
      { id: 'c1', name: 'lookup', output: { rows: 1 } },
      { id: 'c2', name: 'retrieve', output: { passages: [] } },
    ]);

    const stored = (await store.getThread(thread.id))?.messages.find(
      (candidate) => candidate.id === message.id,
    );
    // The message's own list, in the order the turn settled it — not one re-derived from the
    // tool-call rows, whose order is their own and whose shape for a rejection is not this one.
    expect(stored?.toolResults).toEqual([
      { id: 'c1', name: 'lookup', output: { rows: 1 } },
      { id: 'c2', name: 'retrieve', output: { passages: [] } },
    ]);
  });

  it('completes a message that carries calls and no results of its own from their rows', async () => {
    const thread = await store.createThread({ actor: { id: 'actor-1' } });
    const message = await store.appendMessage({
      threadId: thread.id,
      role: 'assistant',
      content: 'looking',
      toolCalls: [{ id: 'orphan-1', name: 'lookup', input: {}, kind: 'read' }],
    });
    await store.recordToolCall({
      toolCallId: 'orphan-1',
      messageId: message.id,
      toolName: 'lookup',
      toolType: 'read',
      input: {},
      status: 'auto_executed',
    });
    await store.updateToolCall({
      toolCallId: 'orphan-1',
      status: 'executed',
      output: { rows: 2 },
    });

    const stored = (await store.getThread(thread.id))?.messages.find(
      (candidate) => candidate.id === message.id,
    );
    expect(stored?.toolResults).toEqual([{ id: 'orphan-1', name: 'lookup', output: { rows: 2 } }]);
  });
});

describe('MikroOrmAgentStore — a thread patch a client reads back', () => {
  /**
   * Typed `Required<UpdateThreadInput>` so a new field on the patch fails to COMPILE here until this
   * adapter round-trips it. The column and the write existed; `toSummary` never emitted the value,
   * so `getThread` reported no default agent and a turn fell back to the module's.
   */
  const EVERY_PATCH_FIELD: Required<UpdateThreadInput> = {
    title: 'Renamed',
    defaultAgent: 'researcher',
  };

  it('returns every patched field from getThread', async () => {
    const thread = await store.createThread({ actor: { id: 'actor-patch' } });

    await store.updateThread(thread.id, EVERY_PATCH_FIELD);

    expect(await store.getThread(thread.id)).toMatchObject(EVERY_PATCH_FIELD);
  });

  it('reports a never-set default agent as null, and clears it on an explicit null', async () => {
    const thread = await store.createThread({ actor: { id: 'actor-patch-2' } });
    expect((await store.getThread(thread.id))?.defaultAgent).toBeNull();

    await store.updateThread(thread.id, { defaultAgent: 'researcher' });
    expect((await store.getThread(thread.id))?.defaultAgent).toBe('researcher');

    await store.updateThread(thread.id, { defaultAgent: null });
    expect((await store.getThread(thread.id))?.defaultAgent).toBeNull();
  });

  it('reads the default agent without materializing the thread', async () => {
    const thread = await store.createThread({ actor: { id: 'actor-projection' } });
    expect(await store.defaultAgentForThread(thread.id)).toBeNull();

    await store.updateThread(thread.id, { defaultAgent: 'researcher' });
    expect(await store.defaultAgentForThread(thread.id)).toBe('researcher');

    expect(await store.defaultAgentForThread('missing')).toBeNull();
    await store.softDeleteThread(thread.id);
    expect(await store.defaultAgentForThread(thread.id)).toBeNull();
  });
});

/**
 * Every terminal the SPI can hand a store has to be NAMEABLE by the row it lands in. The
 * `satisfies` is the whole check: a `recordRunEnd` declaring a narrower parameter still accepts
 * `'cancelled'` and writes it through (method parameters are bivariant), so at runtime nothing is
 * wrong — but the entity tells every reader a cancelled run is impossible, and a reliability read
 * then has no way to leave a user pressing Stop out of its failure count.
 */
const TERMINALS = ['completed', 'failed', 'cancelled'] as const satisfies readonly (AgentRunStatus &
  RecordRunEndInput['status'])[];

describe('MikroOrmAgentStore — the terminals a run can settle on', () => {
  it('records and reads back each of them', async () => {
    const thread = await store.createThread({ actor: { id: 'actor-terminals' } });

    for (const status of TERMINALS) {
      const runId = `run-${status}`;
      await store.recordRunStart({ runId, threadId: thread.id, actorRef: 'actor-terminals' });
      await store.recordRunEnd({ runId, status, durationMs: 42 });

      const settled = await orm.em.fork().findOne(AgentRun, { id: runId });
      expect(settled?.status).toBe(status);
      expect(settled?.durationMs).toBe(42);
    }
  });

  it('leaves a cancelled run undiagnosed — a stop is not an error', async () => {
    const cancelled = await orm.em.fork().findOne(AgentRun, { id: 'run-cancelled' });
    expect(cancelled?.errorCode).toBeNull();
    expect(cancelled?.errorMessage).toBeNull();
  });
});

describe('agent_tool_call.message_id is indexed', () => {
  it('renders an index on the column the message-scoped reads run against', async () => {
    // `loadToolResults`' IN (…) and `truncateFrom`'s delete both filter on this column, and MySQL
    // indexes a foreign key for you while Postgres does not. Here the index comes from the ORM (it
    // indexes every m:1 on any SQL platform), so the entity declares none of its own — a second
    // declared index would be a duplicate on every dialect. This pins the coverage we're relying on.
    const statements = await agentSchemaSql(orm, { ifNotExists: false });
    expect(
      statements.some(
        (sql) =>
          /^create index/i.test(sql) && /agent_tool_call/.test(sql) && /message_id/.test(sql),
      ),
    ).toBe(true);
  });
});

const IMAGE = { url: 'https://cdn/a.png', contentType: 'image/png', name: 'a.png' };

describe('MikroOrmAgentStore — which media a live message still references', () => {
  it('reports the referenced subset, scoped to the asking actor', async () => {
    const mine = await store.createThread({ actor: { id: 'actor-ref-1' } });
    const theirs = await store.createThread({ actor: { id: 'actor-ref-2' } });
    await store.appendMessage({
      threadId: mine.id,
      role: 'user',
      content: 'mine',
      attachments: [{ mediaId: 'ref-mine', ...IMAGE }],
    });
    await store.appendMessage({
      threadId: theirs.id,
      role: 'user',
      content: 'theirs',
      attachments: [{ mediaId: 'ref-theirs', ...IMAGE }],
    });

    expect(
      await store.referencedMediaIds('actor-ref-1', ['ref-mine', 'ref-theirs', 'ref-never']),
    ).toEqual(['ref-mine']);
  });

  it('re-derives after truncateFrom, so a regenerated turn frees its media again', async () => {
    const thread = await store.createThread({ actor: { id: 'actor-ref-3' } });
    const message = await store.appendMessage({
      threadId: thread.id,
      role: 'user',
      content: 'look',
      attachments: [{ mediaId: 'ref-sent', ...IMAGE }],
    });
    expect(await store.referencedMediaIds('actor-ref-3', ['ref-sent'])).toEqual(['ref-sent']);

    await store.truncateFrom(thread.id, message.id);

    expect(await store.referencedMediaIds('actor-ref-3', ['ref-sent'])).toEqual([]);
  });

  it('still counts a reference held by a soft-deleted thread', async () => {
    const thread = await store.createThread({ actor: { id: 'actor-ref-4' } });
    await store.appendMessage({
      threadId: thread.id,
      role: 'user',
      content: 'look',
      attachments: [{ mediaId: 'ref-kept', ...IMAGE }],
    });

    await store.softDeleteThread(thread.id);

    // The message row survives a soft delete, so the bytes it points at are not garbage yet — a
    // host that wants them collected removes the thread for real and lets the cascade do it.
    expect(await store.referencedMediaIds('actor-ref-4', ['ref-kept'])).toEqual(['ref-kept']);
  });

  it('carries every message field onto a fork', async () => {
    const thread = await store.createThread({ actor: { id: 'actor-fork' } });
    const appended = await store.appendMessage({
      threadId: thread.id,
      role: 'assistant',
      content: 'here it is',
      ...EVERY_MESSAGE_FIELD,
    });

    const fork = await store.forkThread(thread.id, appended.id);

    const [copied] = (await store.getThread(fork.id))?.messages ?? [];
    expect(copied).toMatchObject(EVERY_MESSAGE_FIELD);
  });
});

/**
 * What a turn reads off a thread is a WINDOW — the last few messages, the title, and whether the
 * thread has ever been answered. `getThread` hands back the transcript instead: every message, every
 * attachment, every tool output the thread ever recorded, all of it parsed and then journaled by the
 * run. A 50-turn thread whose turns each ran a 50 KB tool is 1.9 MB of that, 97% tool results.
 */
describe('MikroOrmAgentStore — the window a turn reads off a thread', () => {
  let windowOrm: MikroORM;
  let windowStore: MikroOrmAgentStore;
  const queries: string[] = [];

  beforeAll(async () => {
    windowOrm = await MikroORM.init({
      driver: SqliteDriver,
      dbName: ':memory:',
      entities: agentEntities(),
      allowGlobalContext: true,
      debug: ['query'],
      logger: (message) => queries.push(message),
    });
    await ensureAgentSchema(windowOrm);
    windowStore = new MikroOrmAgentStore(windowOrm.em);
  });

  afterAll(async () => {
    await windowOrm?.close(true);
  });

  /** A thread whose first message is the assistant's and whose last `count` are the user's. */
  async function threadOf(actorRef: string, count: number): Promise<ThreadSummary> {
    const thread = await windowStore.createThread({ actor: { id: actorRef }, title: 'Long chat' });
    const appended = [
      await windowStore.appendMessage({
        threadId: thread.id,
        role: 'assistant',
        content: 'the first answer',
      }),
    ];
    for (let index = 1; index <= count; index += 1) {
      appended.push(
        await windowStore.appendMessage({
          threadId: thread.id,
          role: 'user',
          content: `question ${index}`,
        }),
      );
    }
    // One second each. They are appended within the same millisecond, and the tiebreak after
    // `created_at` is a random uuid — so which two a window of two holds would be decided by chance.
    const em = windowOrm.em.fork();
    const base = Date.parse('2026-01-01T00:00:00.000Z');
    for (const [index, message] of appended.entries()) {
      await em.nativeUpdate(
        AgentMessage,
        { id: message.id },
        { createdAt: new Date(base + index * 1000) },
      );
    }
    return thread;
  }

  /** The reads that pull message CONTENT — not the one-column count of assistant messages. */
  function transcriptReads(): string[] {
    return queries.filter((query) => /select .*`content`.*from `agent_message`/i.test(query));
  }

  it('returns the newest messages, oldest first, with the fields the turn reads off the thread', async () => {
    const thread = await threadOf('actor-window', 4);
    await windowStore.updateThread(thread.id, { defaultAgent: 'researcher' });

    const page = await windowStore.loadThreadForTurn({ threadId: thread.id, messageLimit: 2 });

    expect(page?.messages.map((message) => message.content)).toEqual(['question 3', 'question 4']);
    expect(page?.title).toBe('Long chat');
    expect(page?.defaultAgent).toBe('researcher');
  });

  it('counts an assistant message the window does not reach', async () => {
    // A thread-start intake asks "has this been answered before?". Answered off the PAGE, a long
    // thread whose window holds only the user's last questions re-introduces itself every turn.
    const thread = await threadOf('actor-window-assistant', 3);

    const page = await windowStore.loadThreadForTurn({ threadId: thread.id, messageLimit: 2 });

    expect(page?.messages.some((message) => message.role === 'assistant')).toBe(false);
    expect(page?.hasAssistantMessage).toBe(true);
  });

  it('asks the database for the window, not for the transcript', async () => {
    const thread = await threadOf('actor-window-sql', 4);
    queries.length = 0;

    await windowStore.loadThreadForTurn({ threadId: thread.id, messageLimit: 2 });

    const [read] = transcriptReads();
    expect(read).toMatch(/limit/i);
    // Named columns, not `a0`.* — the ones a model turn never reads stay in the table.
    expect(read).toMatch(/`content`/);
    expect(read).not.toMatch(/`a0`\.\*/);
    expect(read).not.toMatch(/`usage`/);
    expect(read).not.toMatch(/`follow_ups`/);
  });

  it('reads no messages at all for an empty window', async () => {
    const thread = await threadOf('actor-window-zero', 2);
    queries.length = 0;

    const page = await windowStore.loadThreadForTurn({ threadId: thread.id, messageLimit: 0 });

    expect(page?.messages).toEqual([]);
    expect(page?.hasAssistantMessage).toBe(true);
    expect(transcriptReads()).toEqual([]);
  });

  it('returns the whole thread when no window is asked for', async () => {
    const thread = await threadOf('actor-window-all', 2);

    const page = await windowStore.loadThreadForTurn({ threadId: thread.id });

    expect(page?.messages.map((message) => message.content)).toEqual([
      'the first answer',
      'question 1',
      'question 2',
    ]);
  });

  it('carries the tool results of a message inside the window', async () => {
    const thread = await windowStore.createThread({ actor: { id: 'actor-window-tools' } });
    const message = await windowStore.appendMessage({
      threadId: thread.id,
      role: 'assistant',
      content: 'looking',
      toolCalls: [{ id: 'w1', name: 'lookup', input: {}, kind: 'read' }],
    });
    await windowStore.recordToolCall({
      toolCallId: 'w1',
      messageId: message.id,
      toolName: 'lookup',
      toolType: 'read',
      input: {},
      status: 'auto_executed',
    });
    await windowStore.updateToolCall({ toolCallId: 'w1', status: 'executed', output: { rows: 2 } });

    const page = await windowStore.loadThreadForTurn({ threadId: thread.id, messageLimit: 1 });

    expect(page?.messages[0]?.toolResults).toEqual([
      { id: 'w1', name: 'lookup', output: { rows: 2 } },
    ]);
  });

  it('has nothing to load for a thread that is unknown or soft-deleted', async () => {
    const thread = await threadOf('actor-window-gone', 1);
    expect(await windowStore.loadThreadForTurn({ threadId: 'missing' })).toBeNull();

    await windowStore.softDeleteThread(thread.id);

    expect(await windowStore.loadThreadForTurn({ threadId: thread.id })).toBeNull();
  });
});

/**
 * Everything `recordRunStart` is handed has to land in a column. `parentRunId` — the run that
 * delegated this one — is the case that made this check: the durable journal holds the parent edge
 * and nothing else does, so a run-row reader cannot roll a delegation's cost up to the turn that
 * asked for it, and a DETACHED child outlives its parent's turn, so the transcript cannot pair them
 * either. Typed `Required<RecordRunStartInput>` so the next field fails to COMPILE here first.
 */
function everyRunStartField(threadId: string): Required<RecordRunStartInput> {
  return {
    runId: 'run-child',
    threadId,
    actorRef: 'actor-run-fields',
    agentName: 'researcher',
    parentRunId: 'run-parent',
    promptHash: 'a'.repeat(64),
  };
}

describe('MikroOrmAgentStore — a recorded run round-trips every field it was started with', () => {
  it('reads all of them back off the row', async () => {
    const thread = await store.createThread({ actor: { id: 'actor-run-fields' } });
    const started = everyRunStartField(thread.id);

    await store.recordRunStart(started);

    const em = orm.em.fork();
    expect(await em.findOne(AgentRun, { id: started.runId })).toMatchObject({
      agentName: started.agentName,
      parentRunId: started.parentRunId,
      promptHash: started.promptHash,
    });
  });

  it('leaves the parent null for a turn nobody delegated', async () => {
    const thread = await store.createThread({ actor: { id: 'actor-run-root' } });

    await store.recordRunStart({
      runId: 'run-root',
      threadId: thread.id,
      actorRef: 'actor-run-root',
    });

    const em = orm.em.fork();
    expect((await em.findOne(AgentRun, { id: 'run-root' }))?.parentRunId ?? null).toBeNull();
  });
});
