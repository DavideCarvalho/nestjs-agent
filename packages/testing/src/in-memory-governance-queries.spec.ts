import { THREAD_DETAIL_CONTENT_CHARS, type ToolCallStatus } from '@dudousxd/nestjs-agent-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  InMemoryGovernanceQueries,
  type InMemoryModelPrice,
} from './in-memory-governance-queries.js';
import { InMemoryAgentStore } from './in-memory-store.js';

// Records against a live InMemoryAgentStore, exactly as the agent loop would, then asserts the
// read-model aggregations. A priced model (`gpt-x`) + an unpriced model (`free-y`) exercise the
// unpriced → 0-cost path. All rows land on the current UTC day (the store stamps `new Date()`).

async function seed(): Promise<{ store: InMemoryAgentStore; today: string }> {
  const store = new InMemoryAgentStore();
  const today = new Date().toISOString().slice(0, 10);

  const aliceThread = await store.createThread({
    actor: { id: 'alice' },
    title: 'Alice chat',
  });
  const aliceMessage = await store.appendMessage({
    threadId: aliceThread.id,
    role: 'assistant',
    content: 'looking that up',
  });
  // alice/gpt-x → cost 1*3 + 0.5*15 = 10.5
  await store.recordUsage({
    threadId: aliceThread.id,
    actorRef: 'alice',
    modelId: 'gpt-x',
    purpose: 'chat',
    usage: { inputTokens: 1_000_000, outputTokens: 500_000 },
  });
  // alice/free-y (unpriced) → cost 0
  await store.recordUsage({
    threadId: aliceThread.id,
    actorRef: 'alice',
    modelId: 'free-y',
    purpose: 'chat',
    usage: { inputTokens: 2_000_000, outputTokens: 1_000_000 },
  });
  await store.recordToolCall({
    toolCallId: 'tc-search',
    messageId: aliceMessage.id,
    toolName: 'search',
    toolType: 'read',
    input: {},
    status: 'executed',
  });

  const bobThread = await store.createThread({
    actor: { id: 'bob' },
    title: 'Bob chat',
  });
  const bobMessage = await store.appendMessage({
    threadId: bobThread.id,
    role: 'assistant',
    content: 'on it',
  });
  // bob/gpt-x → cost 0.5*3 + 0.1*15 = 3.0
  await store.recordUsage({
    threadId: bobThread.id,
    actorRef: 'bob',
    modelId: 'gpt-x',
    purpose: 'chat',
    usage: { inputTokens: 500_000, outputTokens: 100_000 },
  });
  await store.recordToolCall({
    toolCallId: 'tc-deploy',
    messageId: bobMessage.id,
    toolName: 'deploy',
    toolType: 'action',
    input: {},
    status: 'pending_approval',
    runId: 'run-deploy',
  });

  return { store, today };
}

const pricing: ReadonlyMap<string, InMemoryModelPrice> = new Map([
  ['gpt-x', { inputPricePer1m: 3, outputPricePer1m: 15 }],
]);

describe('InMemoryGovernanceQueries', () => {
  it('spendByModel aggregates tokens + cost, unpriced model costs 0, priced sorts first', async () => {
    const { store, today } = await seed();
    const queries = new InMemoryGovernanceQueries(store, pricing);
    const rows = await queries.spendByModel({ fromDay: today, toDay: today });
    expect(rows).toHaveLength(2);

    const [priced, unpriced] = rows;
    expect(priced?.modelId).toBe('gpt-x');
    expect(priced?.requests).toBe(2);
    expect(priced?.inputTokens).toBe(1_500_000);
    expect(priced?.outputTokens).toBe(600_000);
    expect(priced?.costUsd).toBeCloseTo(13.5, 6);

    expect(unpriced?.modelId).toBe('free-y');
    expect(unpriced?.requests).toBe(1);
    expect(unpriced?.costUsd).toBe(0);
  });

  it('spendByActor rolls up per-actor tokens + cost across models', async () => {
    const { store, today } = await seed();
    const queries = new InMemoryGovernanceQueries(store, pricing);
    const rows = await queries.spendByActor({ fromDay: today, toDay: today });
    expect(rows).toHaveLength(2);

    const alice = rows.find((row) => row.actorRef === 'alice');
    expect(alice?.requests).toBe(2);
    expect(alice?.totalTokens).toBe(4_500_000);
    expect(alice?.costUsd).toBeCloseTo(10.5, 6);

    const bob = rows.find((row) => row.actorRef === 'bob');
    expect(bob?.requests).toBe(1);
    expect(bob?.totalTokens).toBe(600_000);
    expect(bob?.costUsd).toBeCloseTo(3.0, 6);
  });

  it('usageTrend buckets tokens + cost by UTC day', async () => {
    const { store, today } = await seed();
    const queries = new InMemoryGovernanceQueries(store, pricing);
    const points = await queries.usageTrend({ fromDay: today, toDay: today });
    expect(points).toHaveLength(1);
    expect(points[0]?.day).toBe(today);
    expect(points[0]?.totalTokens).toBe(5_100_000);
    expect(points[0]?.costUsd).toBeCloseTo(13.5, 6);
  });

  it('an out-of-range window yields no spend', async () => {
    const { store } = await seed();
    const queries = new InMemoryGovernanceQueries(store, pricing);
    expect(await queries.spendByModel({ fromDay: '1999-01-01', toDay: '1999-12-31' })).toEqual([]);
  });

  it('defaults to zero cost when no pricing map is supplied', async () => {
    const { store, today } = await seed();
    const queries = new InMemoryGovernanceQueries(store);
    const rows = await queries.spendByModel({ fromDay: today, toDay: today });
    expect(rows.every((row) => row.costUsd === 0)).toBe(true);
    // tokens still counted even with no pricing
    expect(rows.reduce((sum, row) => sum + row.inputTokens + row.outputTokens, 0)).toBe(5_100_000);
  });

  it('prefers the provider-reported cost over the pricing estimate, per row', async () => {
    const store = new InMemoryAgentStore();
    const today = new Date().toISOString().slice(0, 10);
    const thread = await store.createThread({
      actor: { id: 'alice' },
      title: 'Gateway chat',
    });
    // gpt-x would estimate 1*3 + 0.5*15 = 10.5, but the gateway reported 4.2 — the report wins.
    await store.recordUsage({
      threadId: thread.id,
      actorRef: 'alice',
      modelId: 'gpt-x',
      purpose: 'chat',
      usage: { inputTokens: 1_000_000, outputTokens: 500_000 },
      costUsd: 4.2,
    });
    // an unpriced model that still reports a real cost — no longer collapses to 0.
    await store.recordUsage({
      threadId: thread.id,
      actorRef: 'alice',
      modelId: 'free-y',
      purpose: 'chat',
      usage: { inputTokens: 2_000_000, outputTokens: 1_000_000 },
      costUsd: 1.3,
    });
    const queries = new InMemoryGovernanceQueries(store, pricing);

    const byModel = await queries.spendByModel({ fromDay: today, toDay: today });
    expect(byModel.find((row) => row.modelId === 'gpt-x')?.costUsd).toBeCloseTo(4.2, 6);
    expect(byModel.find((row) => row.modelId === 'free-y')?.costUsd).toBeCloseTo(1.3, 6);

    const byActor = await queries.spendByActor({ fromDay: today, toDay: today });
    expect(byActor.find((row) => row.actorRef === 'alice')?.costUsd).toBeCloseTo(5.5, 6);

    const trend = await queries.usageTrend({ fromDay: today, toDay: today });
    expect(trend[0]?.costUsd).toBeCloseTo(5.5, 6);
  });

  it('prices cache-write and cache-read tokens at their own rates, uncached remainder at input rate', async () => {
    const store = new InMemoryAgentStore();
    const today = new Date().toISOString().slice(0, 10);
    const thread = await store.createThread({
      actor: { id: 'alice' },
      title: 'Cached chat',
    });
    // Of 1M input tokens, 200k were cache writes and 300k cache reads → 500k uncached.
    // cost = 0.5*3 + 0.2*3.75 + 0.3*0.3 + 0.5*15 = 1.5 + 0.75 + 0.09 + 7.5 = 9.84
    // (naive input*inputPrice would have charged 10.5).
    await store.recordUsage({
      threadId: thread.id,
      actorRef: 'alice',
      modelId: 'gpt-x',
      purpose: 'chat',
      usage: {
        inputTokens: 1_000_000,
        outputTokens: 500_000,
        cacheWriteTokens: 200_000,
        cacheReadTokens: 300_000,
      },
    });
    const cachePricing: ReadonlyMap<string, InMemoryModelPrice> = new Map([
      [
        'gpt-x',
        {
          inputPricePer1m: 3,
          outputPricePer1m: 15,
          cacheWritePricePer1m: 3.75,
          cacheReadPricePer1m: 0.3,
        },
      ],
    ]);
    const queries = new InMemoryGovernanceQueries(store, cachePricing);
    const rows = await queries.spendByModel({ fromDay: today, toDay: today });
    expect(rows[0]?.costUsd).toBeCloseTo(9.84, 6);
    // input/output token columns are unchanged — cache tokens are a subset of inputTokens
    expect(rows[0]?.inputTokens).toBe(1_000_000);
    expect(rows[0]?.outputTokens).toBe(500_000);
  });

  it('falls back to the input rate for cache tokens when no cache price is configured', async () => {
    const store = new InMemoryAgentStore();
    const today = new Date().toISOString().slice(0, 10);
    const thread = await store.createThread({
      actor: { id: 'alice' },
      title: 'Cached chat',
    });
    await store.recordUsage({
      threadId: thread.id,
      actorRef: 'alice',
      modelId: 'gpt-x',
      purpose: 'chat',
      usage: {
        inputTokens: 1_000_000,
        outputTokens: 500_000,
        cacheWriteTokens: 200_000,
        cacheReadTokens: 300_000,
      },
    });
    // no cache prices on gpt-x → all input-side tokens at 3 → 1*3 + 0.5*15 = 10.5
    const queries = new InMemoryGovernanceQueries(store, pricing);
    const rows = await queries.spendByModel({ fromDay: today, toDay: today });
    expect(rows[0]?.costUsd).toBeCloseTo(10.5, 6);
  });

  it('recentToolCalls resolves the thread id and caps at the limit', async () => {
    const { store } = await seed();
    const queries = new InMemoryGovernanceQueries(store, pricing);
    const rows = await queries.recentToolCalls(10);
    expect(rows).toHaveLength(2);

    const search = rows.find((row) => row.toolCallId === 'tc-search');
    expect(search?.toolName).toBe('search');
    expect(search?.toolType).toBe('read');
    expect(search?.threadId).toBeTruthy();
    // recorded with no runId — resolves to null, not undefined, for the telescope bridge's link column.
    expect(search?.runId).toBeNull();

    const deploy = rows.find((row) => row.toolCallId === 'tc-deploy');
    expect(deploy?.status).toBe('pending_approval');
    expect(deploy?.threadId).not.toBe(search?.threadId);
    expect(deploy?.runId).toBe('run-deploy');

    expect(await queries.recentToolCalls(1)).toHaveLength(1);
  });

  it('spendByThread ranks threads highest cost first and caps at limit', async () => {
    const store = new InMemoryAgentStore();
    const today = new Date().toISOString().slice(0, 10);

    const threadX = await store.createThread({ actor: { id: 'erin' }, title: 'Thread X' });
    // thread-x: 1M/500k → 1*3 + 0.5*15 = 10.5
    await store.recordUsage({
      threadId: threadX.id,
      actorRef: 'erin',
      modelId: 'gpt-x',
      purpose: 'chat',
      usage: { inputTokens: 1_000_000, outputTokens: 500_000 },
    });

    const threadY = await store.createThread({ actor: { id: 'erin' }, title: 'Thread Y' });
    // thread-y: 500k/100k → 0.5*3 + 0.1*15 = 3.0
    await store.recordUsage({
      threadId: threadY.id,
      actorRef: 'erin',
      modelId: 'gpt-x',
      purpose: 'chat',
      usage: { inputTokens: 500_000, outputTokens: 100_000 },
    });

    const threadZ = await store.createThread({ actor: { id: 'frank' }, title: 'Thread Z' });
    // thread-z: 200k/100k → 0.2*3 + 0.1*15 = 2.1
    await store.recordUsage({
      threadId: threadZ.id,
      actorRef: 'frank',
      modelId: 'gpt-x',
      purpose: 'chat',
      usage: { inputTokens: 200_000, outputTokens: 100_000 },
    });

    const queries = new InMemoryGovernanceQueries(store, pricing);
    const range = { fromDay: today, toDay: today };

    const rows = await queries.spendByThread(range, 10);
    expect(rows.map((row) => row.threadId)).toEqual([threadX.id, threadY.id, threadZ.id]);
    expect(rows[0]).toMatchObject({ title: 'Thread X', actorRef: 'erin', requests: 1 });
    expect(rows[0]?.costUsd).toBeCloseTo(10.5, 6);
    expect(rows[1]?.costUsd).toBeCloseTo(3.0, 6);
    expect(rows[2]?.costUsd).toBeCloseTo(2.1, 6);

    const capped = await queries.spendByThread(range, 2);
    expect(capped.map((row) => row.threadId)).toEqual([threadX.id, threadY.id]);

    const byActor = await queries.spendByActor(range);
    expect(byActor.find((row) => row.actorRef === 'erin')?.threadCount).toBe(2);
    expect(byActor.find((row) => row.actorRef === 'frank')?.threadCount).toBe(1);
  });

  it('recentThreads rolls up message count + tokens per thread', async () => {
    const { store } = await seed();
    const queries = new InMemoryGovernanceQueries(store, pricing);
    const rows = await queries.recentThreads(10);
    expect(rows).toHaveLength(2);

    const alice = rows.find((row) => row.title === 'Alice chat');
    expect(alice?.actorRef).toBe('alice');
    expect(alice?.messageCount).toBe(1);
    expect(alice?.totalTokens).toBe(4_500_000);

    const bob = rows.find((row) => row.title === 'Bob chat');
    expect(bob?.messageCount).toBe(1);
    expect(bob?.totalTokens).toBe(600_000);
  });
});

// The five reliability (run) queries — recordRunStart/recordRunEnd/bumpRunRetries on the store,
// aggregated through InMemoryGovernanceQueries. Mirrors the SQL adapter's db-spec fixtures/math.
describe('InMemoryGovernanceQueries run reliability', () => {
  it('runMetrics aggregates counts, successRate, retries and duration percentiles', async () => {
    const store = new InMemoryAgentStore();
    const thread = await store.createThread({ actor: { id: 'hank' } });
    const today = new Date().toISOString().slice(0, 10);
    const queries = new InMemoryGovernanceQueries(store);

    // run-1: completed, one retry, duration 100
    await store.recordRunStart({
      runId: 'run-1',
      threadId: thread.id,
      actorRef: 'hank',
      agentName: 'researcher',
    });
    await store.bumpRunRetries('run-1');
    await store.recordRunEnd({ runId: 'run-1', status: 'completed', durationMs: 100 });

    // run-2: failed, duration 200, classified error
    await store.recordRunStart({
      runId: 'run-2',
      threadId: thread.id,
      actorRef: 'hank',
      agentName: 'researcher',
    });
    await store.recordRunEnd({
      runId: 'run-2',
      status: 'failed',
      durationMs: 200,
      errorCode: 'timeout',
      errorMessage: 'upstream timed out',
    });

    // run-3: completed, no agentName ('(default)' bucket), duration 300
    await store.recordRunStart({ runId: 'run-3', threadId: thread.id, actorRef: 'hank' });
    await store.recordRunEnd({ runId: 'run-3', status: 'completed', durationMs: 300 });

    // run-4: still running — excluded from completed/failed counts and from the duration set
    await store.recordRunStart({ runId: 'run-4', threadId: thread.id, actorRef: 'hank' });

    const range = { fromDay: today, toDay: today };
    const metrics = await queries.runMetrics(range);
    expect(metrics.runs).toBe(4);
    expect(metrics.completed).toBe(2);
    expect(metrics.failed).toBe(1);
    expect(metrics.successRate).toBeCloseTo(0.5, 6);
    expect(metrics.retries).toBe(1);
    // settled durations ascending: [100, 200, 300] → p50 offset 1, p95 offset 2
    expect(metrics.durationP50Ms).toBe(200);
    expect(metrics.durationP95Ms).toBe(300);

    const byAgent = await queries.runsByAgent(range);
    expect(byAgent.find((row) => row.agentName === 'researcher')).toEqual({
      agentName: 'researcher',
      runs: 2,
      failed: 1,
      retries: 1,
    });
    expect(byAgent.find((row) => row.agentName === '(default)')).toEqual({
      agentName: '(default)',
      runs: 2,
      failed: 0,
      retries: 0,
    });

    expect(await queries.runErrors(range)).toEqual([{ errorCode: 'timeout', count: 1 }]);
  });

  it('runMetrics reports successRate 0 and null percentiles when there are no runs in range', async () => {
    const store = new InMemoryAgentStore();
    const queries = new InMemoryGovernanceQueries(store);
    const today = new Date().toISOString().slice(0, 10);

    expect(await queries.runMetrics({ fromDay: today, toDay: today })).toEqual({
      runs: 0,
      completed: 0,
      failed: 0,
      successRate: 0,
      retries: 0,
      durationP50Ms: null,
      durationP95Ms: null,
    });
  });

  it('runTrend buckets by UTC day and recentRuns orders newest-first, capped, with nulls for an unsettled run', async () => {
    vi.useFakeTimers();
    try {
      const store = new InMemoryAgentStore();
      const thread = await store.createThread({ actor: { id: 'ivan' } });

      vi.setSystemTime(new Date('2026-07-10T09:00:00.000Z'));
      await store.recordRunStart({ runId: 'day1-a', threadId: thread.id, actorRef: 'ivan' });
      await store.recordRunEnd({ runId: 'day1-a', status: 'completed', durationMs: 10 });

      vi.setSystemTime(new Date('2026-07-10T10:00:00.000Z'));
      await store.recordRunStart({ runId: 'day1-b', threadId: thread.id, actorRef: 'ivan' });
      await store.recordRunEnd({ runId: 'day1-b', status: 'failed', errorCode: 'timeout' });

      // day2-a is left running (no recordRunEnd) — the most recent row, unsettled.
      vi.setSystemTime(new Date('2026-07-11T09:00:00.000Z'));
      await store.recordRunStart({ runId: 'day2-a', threadId: thread.id, actorRef: 'ivan' });

      const queries = new InMemoryGovernanceQueries(store);
      const trend = await queries.runTrend({ fromDay: '2026-07-10', toDay: '2026-07-11' });
      expect(trend).toEqual([
        { day: '2026-07-10', runs: 2, failed: 1 },
        { day: '2026-07-11', runs: 1, failed: 0 },
      ]);

      const recent = await queries.recentRuns(10);
      expect(recent.map((row) => row.runId)).toEqual(['day2-a', 'day1-b', 'day1-a']);
      expect(recent.find((row) => row.runId === 'day2-a')).toMatchObject({
        status: 'running',
        agentName: null,
        durationMs: null,
        errorCode: null,
        errorMessage: null,
      });

      const capped = await queries.recentRuns(2);
      expect(capped.map((row) => row.runId)).toEqual(['day2-a', 'day1-b']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('recordRunStart persists promptHash and recentRuns surfaces it; omitted defaults to null', async () => {
    const store = new InMemoryAgentStore();
    const thread = await store.createThread({ actor: { id: 'hank' } });
    const queries = new InMemoryGovernanceQueries(store);

    await store.recordRunStart({
      runId: 'run-hash',
      threadId: thread.id,
      actorRef: 'hank',
      promptHash: 'abc123def456',
    });
    await store.recordRunStart({ runId: 'run-no-hash', threadId: thread.id, actorRef: 'hank' });

    const rows = await queries.recentRuns(10);
    expect(rows.find((row) => row.runId === 'run-hash')?.promptHash).toBe('abc123def456');
    expect(rows.find((row) => row.runId === 'run-no-hash')?.promptHash).toBeNull();
  });
});

// pendingApprovals + toolStats, mirroring the SQL adapters' db-spec fixtures/math.
describe('InMemoryGovernanceQueries approvals + tool stats', () => {
  it('pendingApprovals joins message→thread for title/actorRef/agentName, oldest first, capped', async () => {
    vi.useFakeTimers();
    try {
      const store = new InMemoryAgentStore();
      const queries = new InMemoryGovernanceQueries(store);

      const judyThread = await store.createThread({ actor: { id: 'judy' }, title: 'Judy chat' });
      const kyleThread = await store.createThread({ actor: { id: 'kyle' }, title: 'Kyle chat' });

      // judy's first message has an agentName; her second one has none (resolves to null).
      const messageJudyA = await store.appendMessage({
        threadId: judyThread.id,
        role: 'assistant',
        content: 'deploying',
        agentName: 'assistant-1',
      });
      const messageJudyB = await store.appendMessage({
        threadId: judyThread.id,
        role: 'assistant',
        content: 'restarting',
      });
      const messageKyle = await store.appendMessage({
        threadId: kyleThread.id,
        role: 'assistant',
        content: 'deleting',
        agentName: 'assistant-2',
      });

      // Three pending approvals across the two threads, plus one already-executed call that must
      // be excluded. Oldest first: tc-pa-1, tc-pa-2, tc-pa-3.
      vi.setSystemTime(new Date('2026-07-10T09:00:00.000Z'));
      await store.recordToolCall({
        toolCallId: 'tc-pa-1',
        messageId: messageJudyA.id,
        toolName: 'deploy',
        toolType: 'action',
        input: { env: 'prod' },
        status: 'pending_approval',
        runId: 'run-pa-1',
      });

      vi.setSystemTime(new Date('2026-07-10T10:00:00.000Z'));
      await store.recordToolCall({
        toolCallId: 'tc-pa-2',
        messageId: messageKyle.id,
        toolName: 'delete',
        toolType: 'action',
        input: { id: 1 },
        status: 'pending_approval',
      });

      vi.setSystemTime(new Date('2026-07-10T11:00:00.000Z'));
      await store.recordToolCall({
        toolCallId: 'tc-pa-3',
        messageId: messageJudyB.id,
        toolName: 'restart',
        toolType: 'action',
        input: {},
        status: 'pending_approval',
      });

      await store.recordToolCall({
        toolCallId: 'tc-executed',
        messageId: messageJudyA.id,
        toolName: 'search',
        toolType: 'read',
        input: {},
        status: 'executed',
      });

      const rows = await queries.pendingApprovals(10);
      expect(rows.map((row) => row.toolCallId)).toEqual(['tc-pa-1', 'tc-pa-2', 'tc-pa-3']);

      expect(rows[0]).toMatchObject({
        toolName: 'deploy',
        input: { env: 'prod' },
        threadId: judyThread.id,
        threadTitle: 'Judy chat',
        actorRef: 'judy',
        agentName: 'assistant-1',
        runId: 'run-pa-1',
      });

      expect(rows[1]).toMatchObject({
        toolName: 'delete',
        threadId: kyleThread.id,
        threadTitle: 'Kyle chat',
        actorRef: 'kyle',
        agentName: 'assistant-2',
        // recorded with no runId — resolves to null, not undefined.
        runId: null,
      });

      // judy's second message carries no agentName — resolves to null, not undefined.
      expect(rows[2]).toMatchObject({
        toolName: 'restart',
        threadId: judyThread.id,
        agentName: null,
      });

      const capped = await queries.pendingApprovals(2);
      expect(capped.map((row) => row.toolCallId)).toEqual(['tc-pa-1', 'tc-pa-2']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('toolStats buckets by tool+type, counts failed/rejected, computes p50/p95 execution latency, and respects range bounds', async () => {
    vi.useFakeTimers();
    try {
      const store = new InMemoryAgentStore();
      const queries = new InMemoryGovernanceQueries(store);
      const thread = await store.createThread({ actor: { id: 'judy' } });
      const message = await store.appendMessage({
        threadId: thread.id,
        role: 'assistant',
        content: 'x',
      });

      const record = async (
        toolCallId: string,
        toolName: string,
        toolType: 'read' | 'action',
        status: ToolCallStatus,
        executionMs?: number,
      ): Promise<void> => {
        await store.recordToolCall({
          toolCallId,
          messageId: message.id,
          toolName,
          toolType,
          input: {},
          status,
        });
        if (executionMs !== undefined) {
          await store.updateToolCall({ toolCallId, status, executionMs });
        }
      };

      // search/read x3 (executed + auto_executed), deploy/action x2 (one failed, one rejected),
      // notify/action x1 (executed but never recorded an executionMs), plus one out-of-range
      // search call that must be excluded entirely.
      vi.setSystemTime(new Date('2026-07-20T09:00:00.000Z'));
      await record('tc-stats-search-1', 'search', 'read', 'executed', 50);
      vi.setSystemTime(new Date('2026-07-20T09:05:00.000Z'));
      await record('tc-stats-search-2', 'search', 'read', 'executed', 150);
      vi.setSystemTime(new Date('2026-07-20T09:10:00.000Z'));
      await record('tc-stats-search-3', 'search', 'read', 'auto_executed', 250);
      vi.setSystemTime(new Date('2026-07-20T10:00:00.000Z'));
      await record('tc-stats-deploy-1', 'deploy', 'action', 'failed', 500);
      vi.setSystemTime(new Date('2026-07-20T10:05:00.000Z'));
      await record('tc-stats-deploy-2', 'deploy', 'action', 'rejected');
      vi.setSystemTime(new Date('2026-07-21T09:00:00.000Z'));
      await record('tc-stats-notify-1', 'notify', 'action', 'executed');
      vi.setSystemTime(new Date('2026-07-19T09:00:00.000Z'));
      await record('tc-stats-search-out', 'search', 'read', 'executed', 999);

      const rows = await queries.toolStats({ fromDay: '2026-07-20', toDay: '2026-07-21' });
      expect(rows).toEqual([
        {
          toolName: 'search',
          toolType: 'read',
          calls: 3,
          failed: 0,
          rejected: 0,
          // sample [50, 150, 250] — same math as the SQL adapters' db specs.
          p50ExecutionMs: 150,
          p95ExecutionMs: 250,
        },
        {
          toolName: 'deploy',
          toolType: 'action',
          calls: 2,
          failed: 1,
          rejected: 1,
          p50ExecutionMs: 500,
          p95ExecutionMs: 500,
        },
        {
          toolName: 'notify',
          toolType: 'action',
          calls: 1,
          failed: 0,
          rejected: 0,
          p50ExecutionMs: null,
          p95ExecutionMs: null,
        },
      ]);

      expect(await queries.toolStats({ fromDay: '2020-01-01', toDay: '2020-01-01' })).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

// toolCallsPage/threadsPage/runsPage — real total + offset pagination and every where field,
// mirroring the SQL adapters' db-spec fixtures/math.
describe('InMemoryGovernanceQueries toolCallsPage', () => {
  async function seed(): Promise<{
    store: InMemoryAgentStore;
    queries: InMemoryGovernanceQueries;
    threadA: string;
    threadB: string;
  }> {
    const store = new InMemoryAgentStore();
    const queries = new InMemoryGovernanceQueries(store);
    const threadA = await store.createThread({ actor: { id: 'alice' } });
    const threadB = await store.createThread({ actor: { id: 'bob' } });
    const messageA = await store.appendMessage({
      threadId: threadA.id,
      role: 'assistant',
      content: 'x',
    });
    const messageB = await store.appendMessage({
      threadId: threadB.id,
      role: 'assistant',
      content: 'y',
    });

    // Newest-first order is tc-5, tc-4, tc-3, tc-2, tc-1.
    vi.setSystemTime(new Date('2026-07-10T09:00:00.000Z'));
    await store.recordToolCall({
      toolCallId: 'tc-1',
      messageId: messageA.id,
      toolName: 'search',
      toolType: 'read',
      input: {},
      status: 'executed',
    });
    vi.setSystemTime(new Date('2026-07-10T10:00:00.000Z'));
    await store.recordToolCall({
      toolCallId: 'tc-2',
      messageId: messageA.id,
      toolName: 'deploy',
      toolType: 'action',
      input: {},
      status: 'pending_approval',
    });
    vi.setSystemTime(new Date('2026-07-11T09:00:00.000Z'));
    await store.recordToolCall({
      toolCallId: 'tc-3',
      messageId: messageB.id,
      toolName: 'search',
      toolType: 'read',
      input: {},
      status: 'failed',
    });
    vi.setSystemTime(new Date('2026-07-12T09:00:00.000Z'));
    await store.recordToolCall({
      toolCallId: 'tc-4',
      messageId: messageB.id,
      toolName: 'notify',
      toolType: 'action',
      input: {},
      status: 'executed',
    });
    vi.setSystemTime(new Date('2026-07-13T09:00:00.000Z'));
    await store.recordToolCall({
      toolCallId: 'tc-5',
      messageId: messageA.id,
      toolName: 'search',
      toolType: 'action',
      input: {},
      status: 'rejected',
      runId: 'run-tc-5',
    });

    return { store, queries, threadA: threadA.id, threadB: threadB.id };
  }

  it('paginates newest-first: page 2 rows + total, past-end empty page, pageSize respected', async () => {
    vi.useFakeTimers();
    try {
      const { queries } = await seed();

      const page1 = await queries.toolCallsPage({ page: 1, pageSize: 2 });
      expect(page1.rows.map((row) => row.toolCallId)).toEqual(['tc-5', 'tc-4']);
      expect(page1.total).toBe(5);
      expect(page1.rows).toHaveLength(2);
      // tc-5 was recorded with a runId (for the telescope bridge's trace link); tc-4 was not → null.
      expect(page1.rows[0]?.runId).toBe('run-tc-5');
      expect(page1.rows[1]?.runId).toBeNull();

      const page2 = await queries.toolCallsPage({ page: 2, pageSize: 2 });
      expect(page2.rows.map((row) => row.toolCallId)).toEqual(['tc-3', 'tc-2']);
      expect(page2.total).toBe(5);

      const page3 = await queries.toolCallsPage({ page: 3, pageSize: 2 });
      expect(page3.rows.map((row) => row.toolCallId)).toEqual(['tc-1']);

      const pastEnd = await queries.toolCallsPage({ page: 4, pageSize: 2 });
      expect(pastEnd.rows).toEqual([]);
      expect(pastEnd.total).toBe(5);
      expect(pastEnd.page).toBe(4);
      expect(pastEnd.pageSize).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('filters by toolName', async () => {
    vi.useFakeTimers();
    try {
      const { queries } = await seed();
      const page = await queries.toolCallsPage({
        page: 1,
        pageSize: 10,
        where: { toolName: 'search' },
      });
      expect(page.rows.map((row) => row.toolCallId)).toEqual(['tc-5', 'tc-3', 'tc-1']);
      expect(page.total).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('filters by toolType', async () => {
    vi.useFakeTimers();
    try {
      const { queries } = await seed();
      const page = await queries.toolCallsPage({
        page: 1,
        pageSize: 10,
        where: { toolType: 'action' },
      });
      expect(page.rows.map((row) => row.toolCallId)).toEqual(['tc-5', 'tc-4', 'tc-2']);
      expect(page.total).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('filters by status', async () => {
    vi.useFakeTimers();
    try {
      const { queries } = await seed();
      const page = await queries.toolCallsPage({
        page: 1,
        pageSize: 10,
        where: { status: 'executed' },
      });
      expect(page.rows.map((row) => row.toolCallId)).toEqual(['tc-4', 'tc-1']);
      expect(page.total).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('filters by threadId', async () => {
    vi.useFakeTimers();
    try {
      const { queries, threadA } = await seed();
      const page = await queries.toolCallsPage({
        page: 1,
        pageSize: 10,
        where: { threadId: threadA },
      });
      expect(page.rows.map((row) => row.toolCallId)).toEqual(['tc-5', 'tc-2', 'tc-1']);
      expect(page.total).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('filters by inclusive fromDay/toDay bounds', async () => {
    vi.useFakeTimers();
    try {
      const { queries } = await seed();
      const page = await queries.toolCallsPage({
        page: 1,
        pageSize: 10,
        where: { fromDay: '2026-07-11', toDay: '2026-07-12' },
      });
      expect(page.rows.map((row) => row.toolCallId)).toEqual(['tc-4', 'tc-3']);
      expect(page.total).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('combines filters (toolName + threadId)', async () => {
    vi.useFakeTimers();
    try {
      const { queries, threadA } = await seed();
      const page = await queries.toolCallsPage({
        page: 1,
        pageSize: 10,
        where: { toolName: 'search', threadId: threadA },
      });
      expect(page.rows.map((row) => row.toolCallId)).toEqual(['tc-5', 'tc-1']);
      expect(page.total).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('InMemoryGovernanceQueries threadsPage', () => {
  async function seed(): Promise<{
    store: InMemoryAgentStore;
    queries: InMemoryGovernanceQueries;
  }> {
    const store = new InMemoryAgentStore();
    const queries = new InMemoryGovernanceQueries(store);

    // Newest-first order is t5, t4, t3, t2, t1.
    vi.setSystemTime(new Date('2026-07-10T09:00:00.000Z'));
    await store.createThread({ actor: { id: 'erin' }, title: 'Erin Chat One' });
    vi.setSystemTime(new Date('2026-07-11T09:00:00.000Z'));
    // Mixed case, to prove the title match is case-insensitive.
    await store.createThread({ actor: { id: 'erin' }, title: 'ERIN Chat Two' });
    vi.setSystemTime(new Date('2026-07-12T09:00:00.000Z'));
    await store.createThread({ actor: { id: 'frank' }, title: 'Frank Notes' });
    vi.setSystemTime(new Date('2026-07-13T09:00:00.000Z'));
    await store.createThread({ actor: { id: 'frank' }, title: 'Something else' });
    vi.setSystemTime(new Date('2026-07-14T09:00:00.000Z'));
    await store.createThread({ actor: { id: 'erin' }, title: 'Random Notes' });

    return { store, queries };
  }

  it('paginates newest-first: page 2 rows + total, past-end empty page, pageSize respected', async () => {
    vi.useFakeTimers();
    try {
      const { queries } = await seed();

      const page1 = await queries.threadsPage({ page: 1, pageSize: 2 });
      expect(page1.rows.map((row) => row.title)).toEqual(['Random Notes', 'Something else']);
      expect(page1.total).toBe(5);
      expect(page1.rows).toHaveLength(2);

      const page2 = await queries.threadsPage({ page: 2, pageSize: 2 });
      expect(page2.rows.map((row) => row.title)).toEqual(['Frank Notes', 'ERIN Chat Two']);
      expect(page2.total).toBe(5);

      const page3 = await queries.threadsPage({ page: 3, pageSize: 2 });
      expect(page3.rows.map((row) => row.title)).toEqual(['Erin Chat One']);

      const pastEnd = await queries.threadsPage({ page: 4, pageSize: 2 });
      expect(pastEnd.rows).toEqual([]);
      expect(pastEnd.total).toBe(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it('filters by actorRef', async () => {
    vi.useFakeTimers();
    try {
      const { queries } = await seed();
      const page = await queries.threadsPage({
        page: 1,
        pageSize: 10,
        where: { actorRef: 'erin' },
      });
      expect(page.rows.map((row) => row.title)).toEqual([
        'Random Notes',
        'ERIN Chat Two',
        'Erin Chat One',
      ]);
      expect(page.total).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('filters by title, case-insensitively', async () => {
    vi.useFakeTimers();
    try {
      const { queries } = await seed();
      const page = await queries.threadsPage({
        page: 1,
        pageSize: 10,
        where: { title: 'chat' },
      });
      expect(page.rows.map((row) => row.title)).toEqual(['ERIN Chat Two', 'Erin Chat One']);
      expect(page.total).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('filters by inclusive fromDay/toDay bounds', async () => {
    vi.useFakeTimers();
    try {
      const { queries } = await seed();
      const page = await queries.threadsPage({
        page: 1,
        pageSize: 10,
        where: { fromDay: '2026-07-12', toDay: '2026-07-13' },
      });
      expect(page.rows.map((row) => row.title)).toEqual(['Something else', 'Frank Notes']);
      expect(page.total).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('combines filters (actorRef + title)', async () => {
    vi.useFakeTimers();
    try {
      const { queries } = await seed();
      const page = await queries.threadsPage({
        page: 1,
        pageSize: 10,
        where: { actorRef: 'erin', title: 'notes' },
      });
      expect(page.rows.map((row) => row.title)).toEqual(['Random Notes']);
      expect(page.total).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('InMemoryGovernanceQueries runsPage', () => {
  async function seed(): Promise<{
    store: InMemoryAgentStore;
    queries: InMemoryGovernanceQueries;
    otherThreadId: string;
  }> {
    const store = new InMemoryAgentStore();
    const queries = new InMemoryGovernanceQueries(store);
    const thread = await store.createThread({ actor: { id: 'hank' } });
    // A second thread so `threadId` filtering is meaningful (r1..r5 all live on `thread`).
    const otherThread = await store.createThread({ actor: { id: 'ida' } });

    // Newest-first order is r5, r4, r3, r2, r1.
    vi.setSystemTime(new Date('2026-07-10T09:00:00.000Z'));
    await store.recordRunStart({
      runId: 'r1',
      threadId: thread.id,
      actorRef: 'hank',
      agentName: 'researcher',
    });
    await store.recordRunEnd({ runId: 'r1', status: 'completed', durationMs: 100 });

    vi.setSystemTime(new Date('2026-07-11T09:00:00.000Z'));
    await store.recordRunStart({
      runId: 'r2',
      threadId: thread.id,
      actorRef: 'hank',
      agentName: 'researcher',
    });
    await store.recordRunEnd({ runId: 'r2', status: 'failed', errorCode: 'timeout' });

    vi.setSystemTime(new Date('2026-07-12T09:00:00.000Z'));
    await store.recordRunStart({ runId: 'r3', threadId: thread.id, actorRef: 'hank' });
    await store.recordRunEnd({ runId: 'r3', status: 'completed', durationMs: 300 });

    vi.setSystemTime(new Date('2026-07-13T09:00:00.000Z'));
    await store.recordRunStart({
      runId: 'r4',
      threadId: thread.id,
      actorRef: 'hank',
      agentName: 'planner',
    });
    await store.recordRunEnd({ runId: 'r4', status: 'failed', errorCode: 'validation' });

    vi.setSystemTime(new Date('2026-07-14T09:00:00.000Z'));
    await store.recordRunStart({
      runId: 'r5',
      threadId: thread.id,
      actorRef: 'hank',
      agentName: 'researcher',
    });
    await store.recordRunEnd({ runId: 'r5', status: 'failed', errorCode: 'timeout' });

    vi.setSystemTime(new Date('2026-07-15T09:00:00.000Z'));
    await store.recordRunStart({
      runId: 'r-other-thread',
      threadId: otherThread.id,
      actorRef: 'ida',
    });
    await store.recordRunEnd({ runId: 'r-other-thread', status: 'completed', durationMs: 400 });

    return { store, queries, otherThreadId: otherThread.id };
  }

  it('paginates newest-first: page 2 rows + total, past-end empty page, pageSize respected', async () => {
    vi.useFakeTimers();
    try {
      // Six runs total: r1..r5 on the seed thread plus `r-other-thread` (newest) on a second thread.
      const { queries } = await seed();

      const page1 = await queries.runsPage({ page: 1, pageSize: 2 });
      expect(page1.rows.map((row) => row.runId)).toEqual(['r-other-thread', 'r5']);
      expect(page1.total).toBe(6);
      expect(page1.rows).toHaveLength(2);

      const page2 = await queries.runsPage({ page: 2, pageSize: 2 });
      expect(page2.rows.map((row) => row.runId)).toEqual(['r4', 'r3']);
      expect(page2.total).toBe(6);

      const page3 = await queries.runsPage({ page: 3, pageSize: 2 });
      expect(page3.rows.map((row) => row.runId)).toEqual(['r2', 'r1']);

      const pastEnd = await queries.runsPage({ page: 4, pageSize: 2 });
      expect(pastEnd.rows).toEqual([]);
      expect(pastEnd.total).toBe(6);
    } finally {
      vi.useRealTimers();
    }
  });

  it('filters by threadId', async () => {
    vi.useFakeTimers();
    try {
      const { queries, otherThreadId } = await seed();
      const page = await queries.runsPage({
        page: 1,
        pageSize: 10,
        where: { threadId: otherThreadId },
      });
      expect(page.rows.map((row) => row.runId)).toEqual(['r-other-thread']);
      expect(page.total).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('filters by agentName', async () => {
    vi.useFakeTimers();
    try {
      const { queries } = await seed();
      const page = await queries.runsPage({
        page: 1,
        pageSize: 10,
        where: { agentName: 'researcher' },
      });
      expect(page.rows.map((row) => row.runId)).toEqual(['r5', 'r2', 'r1']);
      expect(page.total).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('filters by status', async () => {
    vi.useFakeTimers();
    try {
      const { queries } = await seed();
      const page = await queries.runsPage({ page: 1, pageSize: 10, where: { status: 'failed' } });
      expect(page.rows.map((row) => row.runId)).toEqual(['r5', 'r4', 'r2']);
      expect(page.total).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('filters by errorCode', async () => {
    vi.useFakeTimers();
    try {
      const { queries } = await seed();
      const page = await queries.runsPage({
        page: 1,
        pageSize: 10,
        where: { errorCode: 'timeout' },
      });
      expect(page.rows.map((row) => row.runId)).toEqual(['r5', 'r2']);
      expect(page.total).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('filters by inclusive fromDay/toDay bounds', async () => {
    vi.useFakeTimers();
    try {
      const { queries } = await seed();
      const page = await queries.runsPage({
        page: 1,
        pageSize: 10,
        where: { fromDay: '2026-07-11', toDay: '2026-07-13' },
      });
      expect(page.rows.map((row) => row.runId)).toEqual(['r4', 'r3', 'r2']);
      expect(page.total).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('combines filters (agentName + status)', async () => {
    vi.useFakeTimers();
    try {
      const { queries } = await seed();
      const page = await queries.runsPage({
        page: 1,
        pageSize: 10,
        where: { agentName: 'researcher', status: 'failed' },
      });
      expect(page.rows.map((row) => row.runId)).toEqual(['r5', 'r2']);
      expect(page.total).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

// approvalsPage + the two drill-downs. Same shape of assertions as the SQL adapters' db specs, so a
// test that swaps this double for a real store sees the same numbers.
describe('InMemoryGovernanceQueries approvalsPage', () => {
  async function seed(): Promise<{
    store: InMemoryAgentStore;
    queries: InMemoryGovernanceQueries;
  }> {
    vi.setSystemTime(new Date('2026-08-01T08:00:00.000Z'));
    const store = new InMemoryAgentStore();
    const queries = new InMemoryGovernanceQueries(store);
    const ops = await store.createThread({ actor: { id: 'ops' } });
    const finance = await store.createThread({ actor: { id: 'finance' } });
    const opsMessage = await store.appendMessage({
      threadId: ops.id,
      role: 'assistant',
      content: 'awaiting approval',
      agentName: 'ops-agent',
    });
    const financeMessage = await store.appendMessage({
      threadId: finance.id,
      role: 'assistant',
      content: 'awaiting approval',
      agentName: 'finance-agent',
    });

    const pending = [
      { id: 'ap-1', at: '2026-08-01T09:00:00.000Z', tool: 'deploy', messageId: opsMessage.id },
      { id: 'ap-2', at: '2026-08-01T09:01:00.000Z', tool: 'deploy', messageId: financeMessage.id },
      { id: 'ap-3a', at: '2026-08-01T09:02:00.000Z', tool: 'refund', messageId: opsMessage.id },
      { id: 'ap-3b', at: '2026-08-01T09:02:00.000Z', tool: 'refund', messageId: financeMessage.id },
      { id: 'ap-4', at: '2026-08-02T09:03:00.000Z', tool: 'restart', messageId: opsMessage.id },
      { id: 'ap-5', at: '2026-08-03T09:04:00.000Z', tool: 'restart', messageId: financeMessage.id },
    ];
    for (const row of pending) {
      vi.setSystemTime(new Date(row.at));
      await store.recordToolCall({
        toolCallId: row.id,
        messageId: row.messageId,
        toolName: row.tool,
        toolType: 'action',
        input: { id: row.id },
        status: 'pending_approval',
        runId: `run-${row.id}`,
      });
    }
    vi.setSystemTime(new Date('2026-08-01T09:00:30.000Z'));
    await store.recordToolCall({
      toolCallId: 'ap-decided',
      messageId: opsMessage.id,
      toolName: 'deploy',
      toolType: 'action',
      input: {},
      status: 'executed',
    });
    return { store, queries };
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports the whole backlog as total even when the page shows a slice of it', async () => {
    const { queries } = await seed();
    const page = await queries.approvalsPage({ page: 1, pageSize: 2 });
    expect(page.rows.map((row) => row.toolCallId)).toEqual(['ap-1', 'ap-2']);
    expect(page).toMatchObject({ total: 6, page: 1, pageSize: 2 });
  });

  it('pages oldest-first with a total order — no row on two pages, none skipped', async () => {
    const { queries } = await seed();
    const seen: string[] = [];
    for (const page of [1, 2, 3, 4]) {
      const result = await queries.approvalsPage({ page, pageSize: 2 });
      seen.push(...result.rows.map((row) => row.toolCallId));
    }
    expect(seen).toEqual(['ap-1', 'ap-2', 'ap-3a', 'ap-3b', 'ap-4', 'ap-5']);
    expect(new Set(seen).size).toBe(6);
  });

  it('never surfaces an already-decided call', async () => {
    const { queries } = await seed();
    const page = await queries.approvalsPage({ page: 1, pageSize: 50 });
    expect(page.rows.map((row) => row.toolCallId)).not.toContain('ap-decided');
    expect(page.total).toBe(6);
  });

  it('filters by toolName / actorRef / agentName and day bounds', async () => {
    const { queries } = await seed();
    expect(
      (await queries.approvalsPage({ page: 1, pageSize: 10, where: { toolName: 'refund' } })).rows
        .length,
    ).toBe(2);
    expect(
      (await queries.approvalsPage({ page: 1, pageSize: 10, where: { actorRef: 'ops' } })).total,
    ).toBe(3);
    expect(
      (
        await queries.approvalsPage({
          page: 1,
          pageSize: 10,
          where: { agentName: 'finance-agent' },
        })
      ).total,
    ).toBe(3);
    const ranged = await queries.approvalsPage({
      page: 1,
      pageSize: 10,
      where: { fromDay: '2026-08-02', toDay: '2026-08-03' },
    });
    expect(ranged.rows.map((row) => row.toolCallId)).toEqual(['ap-4', 'ap-5']);
  });

  it('a filter that matches nothing is an empty page, not an error', async () => {
    const { queries } = await seed();
    expect(
      await queries.approvalsPage({ page: 1, pageSize: 10, where: { toolName: 'nope' } }),
    ).toEqual({ rows: [], total: 0, page: 1, pageSize: 10 });
  });
});

describe('InMemoryGovernanceQueries runDetail + threadDetail', () => {
  async function seed(): Promise<{
    queries: InMemoryGovernanceQueries;
    threadId: string;
    otherThreadId: string;
  }> {
    const store = new InMemoryAgentStore();
    const queries = new InMemoryGovernanceQueries(
      store,
      new Map([['gpt-x', { inputPricePer1m: 3, outputPricePer1m: 15 }]]),
    );
    const thread = await store.createThread({ actor: { id: 'erin' } });
    const other = await store.createThread({ actor: { id: 'frank' } });
    await store.appendMessage({ threadId: thread.id, role: 'user', content: 'ship it' });
    const assistant = await store.appendMessage({
      threadId: thread.id,
      role: 'assistant',
      content: 'x'.repeat(THREAD_DETAIL_CONTENT_CHARS + 500),
      agentName: 'shipper',
    });

    await store.recordRunStart({
      runId: 'run-failed',
      threadId: thread.id,
      actorRef: 'erin',
      agentName: 'shipper',
    });
    await store.recordRunEnd({
      runId: 'run-failed',
      status: 'failed',
      durationMs: 4200,
      errorCode: 'tool_failed',
      errorMessage: 'deploy blew up',
    });
    await store.recordRunStart({ runId: 'run-ok', threadId: thread.id, actorRef: 'erin' });
    await store.recordRunEnd({ runId: 'run-ok', status: 'completed', durationMs: 900 });
    await store.recordRunStart({ runId: 'run-other', threadId: other.id, actorRef: 'frank' });

    await store.recordToolCall({
      toolCallId: 'tc-a',
      messageId: assistant.id,
      toolName: 'deploy',
      toolType: 'action',
      input: {},
      status: 'failed',
      runId: 'run-failed',
    });
    await store.updateToolCall({
      toolCallId: 'tc-a',
      status: 'failed',
      executionMs: 1200,
      error: 'upstream 503',
    });
    await store.recordToolCall({
      toolCallId: 'tc-b',
      messageId: assistant.id,
      toolName: 'search',
      toolType: 'read',
      input: {},
      status: 'executed',
      runId: 'run-failed',
    });
    // Attributed to no run at all — must not show up under run-failed.
    await store.recordToolCall({
      toolCallId: 'tc-orphan',
      messageId: assistant.id,
      toolName: 'notify',
      toolType: 'action',
      input: {},
      status: 'executed',
    });

    await store.recordUsage({
      threadId: thread.id,
      actorRef: 'erin',
      modelId: 'gpt-x',
      purpose: 'chat',
      usage: { inputTokens: 1_000_000, outputTokens: 500_000 },
    });
    await store.recordUsage({
      threadId: other.id,
      actorRef: 'frank',
      modelId: 'gpt-x',
      purpose: 'chat',
      usage: { inputTokens: 9_000_000, outputTokens: 9_000_000 },
    });
    return { queries, threadId: thread.id, otherThreadId: other.id };
  }

  it('runDetail returns the run, its thread headline and only its own tool calls', async () => {
    const { queries, threadId } = await seed();
    const detail = await queries.runDetail('run-failed');
    expect(detail?.run).toMatchObject({
      runId: 'run-failed',
      threadId,
      status: 'failed',
      errorCode: 'tool_failed',
      durationMs: 4200,
    });
    expect(detail?.thread).toMatchObject({ threadId, actorRef: 'erin', deleted: false });
    expect(detail?.toolCalls.map((row) => row.toolCallId)).toEqual(['tc-a', 'tc-b']);
    expect(detail?.toolCalls[0]).toMatchObject({
      toolName: 'deploy',
      status: 'failed',
      executionMs: 1200,
      error: 'upstream 503',
      // This store records no decider attribution on a tool call — documented as always null here.
      executedByRef: null,
    });
  });

  it('runDetail is null for an unknown run id', async () => {
    const { queries } = await seed();
    expect(await queries.runDetail('nope')).toBeNull();
  });

  it('threadDetail rolls up lifetime usage, runs and messages for one thread only', async () => {
    const { queries, threadId } = await seed();
    const detail = await queries.threadDetail({ threadId, messageLimit: 10, runLimit: 10 });
    expect(detail?.thread).toMatchObject({ threadId, messageCount: 2, totalTokens: 1_500_000 });
    // The other thread's 18M-token row must not leak into this rollup.
    expect(detail?.usage).toMatchObject({
      requests: 1,
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      totalTokens: 1_500_000,
    });
    expect(detail?.usage.costUsd).toBeCloseTo(10.5, 6);
    expect(detail?.runs.map((row) => row.runId)).toEqual(['run-ok', 'run-failed']);
    expect(detail?.runTotal).toBe(2);
    // Both messages land in the same millisecond here (the store stamps `new Date()`), so their
    // order is decided by the messageId tiebreak — assert the CONTENT, not the position.
    expect(detail?.messages.map((row) => row.role).sort()).toEqual(['assistant', 'user']);
    expect(detail?.messages.find((row) => row.role === 'assistant')).toMatchObject({
      agentName: 'shipper',
      toolCallCount: 3,
    });
  });

  it('threadDetail truncates a long message body and says that it did', async () => {
    const { queries, threadId } = await seed();
    const detail = await queries.threadDetail({ threadId, messageLimit: 10, runLimit: 10 });
    const assistant = detail?.messages.find((row) => row.role === 'assistant');
    expect(assistant?.content).toHaveLength(THREAD_DETAIL_CONTENT_CHARS);
    expect(assistant?.truncated).toBe(true);
    expect(detail?.messages.find((row) => row.role === 'user')).toMatchObject({
      content: 'ship it',
      truncated: false,
    });
  });

  it('threadDetail caps runs and messages while still reporting the true totals', async () => {
    const { queries, threadId } = await seed();
    const detail = await queries.threadDetail({ threadId, messageLimit: 1, runLimit: 1 });
    expect(detail?.messages).toHaveLength(1);
    expect(detail?.runs.map((row) => row.runId)).toEqual(['run-ok']);
    expect(detail?.runTotal).toBe(2);
    expect(detail?.thread.messageCount).toBe(2);
  });

  it('threadDetail is null for an unknown thread id', async () => {
    const { queries } = await seed();
    expect(
      await queries.threadDetail({ threadId: 'nope', messageLimit: 10, runLimit: 10 }),
    ).toBeNull();
  });
});
