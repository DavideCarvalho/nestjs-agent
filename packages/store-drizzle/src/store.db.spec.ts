// Integration: DrizzleAgentStore + ensureAgentSchema against an in-memory SQLite
// (better-sqlite3, via drizzle-orm/better-sqlite3). Runs only under `pnpm test:db`.
import type { StoredMessage, ThreadSummary } from '@dudousxd/nestjs-agent-core';
import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { DrizzleAgentStore } from './drizzle-agent-store.js';
import { DrizzlePricingStore } from './drizzle-pricing-store.js';
import { ensureAgentSchema } from './ensure-schema.js';
import { agentRun, agentSchema, agentToolCall } from './schema.js';

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
    });
    const [started] = await db.select().from(agentRun).where(eq(agentRun.id, 'run-1'));
    expect(started?.status).toBe('running');
    expect(started?.retries).toBe(0);
    expect(started?.agentName).toBe('researcher');
    expect(started?.settledAt).toBeNull();

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
