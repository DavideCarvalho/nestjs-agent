// Integration: DrizzleAgentStore + ensureAgentSchema against an in-memory SQLite
// (better-sqlite3, via drizzle-orm/better-sqlite3). Runs only under `pnpm test:db`.
import type {
  RecordRunEndInput,
  StoredMessage,
  ThreadSummary,
  UpdateThreadInput,
} from '@dudousxd/nestjs-agent-core';
import { EVERY_MESSAGE_FIELD } from '@dudousxd/nestjs-agent-testing';
import Database from 'better-sqlite3';
import { eq, sql } from 'drizzle-orm';
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { DrizzleAgentStore } from './drizzle-agent-store.js';
import { DrizzlePricingStore } from './drizzle-pricing-store.js';
import { ensureAgentSchema } from './ensure-schema.js';
import { type AgentRunStatus, agentRun, agentSchema, agentToolCall } from './schema.js';

let db: BetterSQLite3Database<typeof agentSchema>;
let store: DrizzleAgentStore;

beforeEach(async () => {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  db = drizzle(sqlite, { schema: agentSchema });
  await ensureAgentSchema(db);
  store = new DrizzleAgentStore(db);
});

describe('DrizzleAgentStore (better-sqlite3)', () => {
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

    // appendMessage (user)
    const userMessage = await store.appendMessage({
      threadId: thread.id,
      role: 'user',
      content: 'Hello',
    });
    expect(userMessage.role).toBe('user');
    expect(userMessage.content).toBe('Hello');

    // appendMessage (assistant with tool calls + usage)
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

    const [toolCall] = await db.select().from(agentToolCall).where(eq(agentToolCall.id, 'tc-1'));
    expect(toolCall?.status).toBe('executed');
    expect(toolCall?.output).toEqual({ result: 'sunny' });
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
    const [noRunToolCall] = await db
      .select()
      .from(agentToolCall)
      .where(eq(agentToolCall.id, 'tc-no-run'));
    expect(noRunToolCall?.runId).toBeNull();

    // ownerOfThread / ownerOfToolCall resolve the owning actorRef for the authz checks
    expect(await store.ownerOfThread(thread.id)).toBe('actor-1');
    expect(await store.ownerOfToolCall('tc-1')).toBe('actor-1');
    expect(await store.ownerOfThread('missing')).toBeNull();
    expect(await store.ownerOfToolCall('missing')).toBeNull();
    expect(toolCall?.executionMs).toBe(12);
    expect(toolCall?.executedByRef).toBe('worker-1');
    expect(toolCall?.executedAt).toBeInstanceOf(Date);

    // getThread → both messages in order, with tool-call data preserved
    const detail = await store.getThread(thread.id);
    expect(detail).not.toBeNull();
    const messages = detail?.messages as StoredMessage[];
    expect(messages).toHaveLength(2);
    expect(messages[0]?.content).toBe('Hello');
    expect(messages[1]?.content).toBe('Looking that up');
    expect(messages[1]?.toolCalls?.[0]?.id).toBe('tc-1');
    expect(messages[1]?.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(messages[1]?.agentName).toBe('researcher');
    expect(detail?.lastMessagePreview).toBe('Looking that up');

    // setTitle + setActiveStream are reflected in getThread
    await store.setTitle(thread.id, 'Renamed');
    await store.setActiveStream(thread.id, 'run-9');
    const afterStream = await store.getThread(thread.id);
    expect(afterStream?.title).toBe('Renamed');
    expect(afterStream?.activeStreamId).toBe('run-9');
    await store.setActiveStream(thread.id, null);
    expect((await store.getThread(thread.id))?.activeStreamId).toBeUndefined();

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
    });
    const quota = await store.quotaToday('actor-1', today);
    expect(quota.usedTokens).toBe(42);
    const otherQuota = await store.quotaToday('actor-2', today);
    expect(otherQuota.usedTokens).toBe(0);

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
    const remaining = await db.select().from(agentToolCall).where(eq(agentToolCall.id, 'tc-1'));
    expect(remaining).toHaveLength(0);

    // listThreads sees both threads before soft delete
    const before: ThreadSummary[] = await store.listThreads('actor-1');
    expect(before.map((t) => t.id).sort()).toEqual([thread.id, fork.id].sort());

    // softDeleteThread → getThread null + excluded from listThreads
    await store.softDeleteThread(thread.id);
    expect(await store.getThread(thread.id)).toBeNull();
    const after = await store.listThreads('actor-1');
    expect(after.map((t) => t.id)).toEqual([fork.id]);
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
    const [started] = await db.select().from(agentRun).where(eq(agentRun.id, 'run-1'));
    expect(started?.status).toBe('running');
    expect(started?.retries).toBe(0);
    expect(started?.agentName).toBe('researcher');
    expect(started?.settledAt).toBeNull();
    expect(started?.promptHash).toBe('abc123def456');

    // bumpRunRetries increments without a read-modify-write race (`retries + 1` in the SQL itself)
    await store.bumpRunRetries('run-1');
    await store.bumpRunRetries('run-1');
    const [bumped] = await db.select().from(agentRun).where(eq(agentRun.id, 'run-1'));
    expect(bumped?.retries).toBe(2);

    await store.recordRunEnd({
      runId: 'run-1',
      status: 'completed',
      durationMs: 1_234,
    });
    const [settled] = await db.select().from(agentRun).where(eq(agentRun.id, 'run-1'));
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
    const [failed] = await db.select().from(agentRun).where(eq(agentRun.id, 'run-2'));
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

  it('resolves the owning actorRef of a thread streaming a run via ownerOfActiveStream', async () => {
    const thread = await store.createThread({
      actor: { id: 'actor-1' },
      title: 'My chat',
    });
    await store.setActiveStream(thread.id, 'run-xyz');
    expect(await store.ownerOfActiveStream('run-xyz')).toBe('actor-1');
    expect(await store.ownerOfActiveStream('missing')).toBeNull();
  });

  it('upserts model prices, superseding the prior current row', async () => {
    const pricingStore = new DrizzlePricingStore(db);

    await pricingStore.upsertModelPrice({ modelId: 'm', inputPricePer1m: 3, outputPricePer1m: 15 });
    const firstPrices = await pricingStore.listCurrentPrices();
    const firstPrice = firstPrices.filter((price) => price.modelId === 'm');
    expect(firstPrice).toHaveLength(1);
    expect(firstPrice[0]?.inputPricePer1m).toBe(3);

    await pricingStore.upsertModelPrice({ modelId: 'm', inputPricePer1m: 4, outputPricePer1m: 16 });
    const secondPrices = await pricingStore.listCurrentPrices();
    const secondPrice = secondPrices.filter((price) => price.modelId === 'm');
    expect(secondPrice).toHaveLength(1);
    expect(secondPrice[0]?.inputPricePer1m).toBe(4);
  });
});

describe('DrizzleAgentStore — a turn a client reads back', () => {
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

    const [stored] = (await store.getThread(thread.id))?.messages ?? [];
    expect(stored?.toolResults).toEqual([
      { id: 'c1', name: 'lookup', output: { rows: 1 } },
      { id: 'c2', name: 'retrieve', output: { passages: [] } },
    ]);
  });
});

describe('DrizzleAgentStore — a thread patch a client reads back', () => {
  /**
   * Typed `Required<UpdateThreadInput>` so a new field on the patch fails to COMPILE here until this
   * adapter round-trips it. `defaultAgent` had no column at all on this adapter and no test noticed:
   * the write went nowhere and the value could never be read back.
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

  it('patches each field independently and clears defaultAgent on an explicit null', async () => {
    const thread = await store.createThread({ actor: { id: 'actor-patch-2' }, title: 'Original' });
    // never set — the column is there and holds null, which is NOT the same as the store not
    // knowing the field (that reads as undefined, and the service normalizes it the same way)
    expect((await store.getThread(thread.id))?.defaultAgent).toBeNull();

    await store.updateThread(thread.id, { title: 'Renamed' });
    expect((await store.getThread(thread.id))?.defaultAgent).toBeNull();

    await store.updateThread(thread.id, { defaultAgent: 'researcher' });
    const patched = await store.getThread(thread.id);
    expect(patched?.title).toBe('Renamed');
    expect(patched?.defaultAgent).toBe('researcher');

    await store.updateThread(thread.id, { defaultAgent: null });
    expect((await store.getThread(thread.id))?.defaultAgent).toBeNull();

    await expect(store.updateThread('missing', { title: 'x' })).resolves.toBeUndefined();
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
 * wrong — but the row type tells every reader a cancelled run is impossible, and a reliability read
 * then has no way to leave a user pressing Stop out of its failure count.
 */
const TERMINALS = ['completed', 'failed', 'cancelled'] as const satisfies readonly (AgentRunStatus &
  RecordRunEndInput['status'])[];

describe('DrizzleAgentStore — the terminals a run can settle on', () => {
  it('records and reads back each of them, leaving a cancelled run undiagnosed', async () => {
    const thread = await store.createThread({ actor: { id: 'actor-terminals' } });

    for (const status of TERMINALS) {
      const runId = `run-${status}`;
      await store.recordRunStart({ runId, threadId: thread.id, actorRef: 'actor-terminals' });
      await store.recordRunEnd({ runId, status, durationMs: 42 });

      const [settled] = await db.select().from(agentRun).where(eq(agentRun.id, runId));
      expect(settled?.status).toBe(status);
      expect(settled?.durationMs).toBe(42);
    }

    // a stop is not a diagnosis — nothing to page anyone about
    const [cancelled] = await db.select().from(agentRun).where(eq(agentRun.id, 'run-cancelled'));
    expect(cancelled?.errorCode).toBeNull();
    expect(cancelled?.errorMessage).toBeNull();
  });
});

describe('ensureAgentSchema (drizzle)', () => {
  it('declares an index on agent_tool_call.message_id', async () => {
    const indexes = await db.all<{ name: string }>(sql.raw('PRAGMA index_list(agent_tool_call)'));
    const indexed: string[] = [];
    for (const { name } of indexes) {
      const columns = await db.all<{ name: string }>(sql.raw(`PRAGMA index_info(${name})`));
      indexed.push(...columns.map((column) => column.name));
    }
    expect(indexed).toContain('message_id');
  });

  it('upgrades tables an older release of this package created', async () => {
    const sqlite = new Database(':memory:');
    // `CREATE TABLE IF NOT EXISTS` is inert against a table that already exists, so the column and
    // the index below only ever land on a running deployment through the additive pass.
    sqlite.exec(`CREATE TABLE agent_thread (
      id TEXT PRIMARY KEY NOT NULL,
      actor_ref TEXT NOT NULL,
      tenant_ref TEXT,
      title TEXT NOT NULL,
      transient INTEGER NOT NULL DEFAULT 0,
      active_stream_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    )`);
    sqlite.exec(`CREATE TABLE agent_message (
      id TEXT PRIMARY KEY NOT NULL,
      thread_id TEXT NOT NULL REFERENCES agent_thread(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      tool_calls TEXT,
      tool_results TEXT,
      attachments TEXT,
      follow_ups TEXT,
      usage TEXT,
      agent_name TEXT,
      run_id TEXT,
      created_at INTEGER NOT NULL
    )`);
    sqlite.exec(`CREATE TABLE agent_tool_call (
      id TEXT PRIMARY KEY NOT NULL,
      message_id TEXT NOT NULL REFERENCES agent_message(id) ON DELETE CASCADE,
      tool_name TEXT NOT NULL,
      tool_type TEXT NOT NULL,
      input TEXT,
      output TEXT,
      status TEXT NOT NULL,
      executed_by_ref TEXT,
      execution_ms INTEGER,
      error TEXT,
      created_at INTEGER NOT NULL,
      executed_at INTEGER,
      run_id TEXT
    )`);
    const aged = drizzle(sqlite, { schema: agentSchema });

    await ensureAgentSchema(aged);

    const agedStore = new DrizzleAgentStore(aged);
    const thread = await agedStore.createThread({ actor: { id: 'actor-upgraded' } });
    await agedStore.updateThread(thread.id, { defaultAgent: 'researcher' });
    expect((await agedStore.getThread(thread.id))?.defaultAgent).toBe('researcher');

    const indexes = await aged.all<{ name: string }>(sql.raw('PRAGMA index_list(agent_tool_call)'));
    expect(indexes.map((index) => index.name)).toContain('agent_tool_call_message_idx');
  });
});

const IMAGE = { url: 'https://cdn/a.png', contentType: 'image/png', name: 'a.png' };

describe('DrizzleAgentStore — which media a live message still references', () => {
  it('reports the referenced subset, scoped to the asking actor', async () => {
    const mine = await store.createThread({ actor: { id: 'actor-ref-1' } });
    const theirs = await store.createThread({ actor: { id: 'actor-ref-2' } });
    await store.appendMessage({
      threadId: mine.id,
      role: 'user',
      content: 'mine',
      attachments: [{ mediaId: 'mine', ...IMAGE }],
    });
    await store.appendMessage({
      threadId: theirs.id,
      role: 'user',
      content: 'theirs',
      attachments: [{ mediaId: 'theirs', ...IMAGE }],
    });

    expect(await store.referencedMediaIds('actor-ref-1', ['mine', 'theirs', 'never'])).toEqual([
      'mine',
    ]);
  });

  it('re-derives after truncateFrom, so a regenerated turn frees its media again', async () => {
    const thread = await store.createThread({ actor: { id: 'actor-ref-3' } });
    const message = await store.appendMessage({
      threadId: thread.id,
      role: 'user',
      content: 'look',
      attachments: [{ mediaId: 'sent', ...IMAGE }],
    });
    expect(await store.referencedMediaIds('actor-ref-3', ['sent'])).toEqual(['sent']);

    await store.truncateFrom(thread.id, message.id);

    expect(await store.referencedMediaIds('actor-ref-3', ['sent'])).toEqual([]);
  });

  it('still counts a reference held by a soft-deleted thread', async () => {
    const thread = await store.createThread({ actor: { id: 'actor-ref-4' } });
    await store.appendMessage({
      threadId: thread.id,
      role: 'user',
      content: 'look',
      attachments: [{ mediaId: 'kept', ...IMAGE }],
    });

    await store.softDeleteThread(thread.id);

    // The message row survives a soft delete, so the bytes it points at are not garbage yet — a
    // host that wants them collected removes the thread for real and lets the cascade do it.
    expect(await store.referencedMediaIds('actor-ref-4', ['kept'])).toEqual(['kept']);
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
