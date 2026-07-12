// Integration: MikroOrmGovernanceQueries against an in-memory SQLite (better-sqlite3, via
// @mikro-orm/sqlite). Seeds a priced model (`gpt-x`, with a superseded non-current pricing row)
// and an unpriced model (`free-y`) plus an out-of-range ledger row, then asserts the read-model
// aggregations. Runs only under `pnpm test:db`.
import { MikroORM, SqliteDriver } from '@mikro-orm/sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureAgentSchema } from './ensure-schema';
import { agentEntities } from './entities';
import { AgentMessage } from './entities/agent-message.entity';
import { AgentModelPricing } from './entities/agent-model-pricing.entity';
import { AgentRun } from './entities/agent-run.entity';
import { AgentThread } from './entities/agent-thread.entity';
import { AgentTokenUsage } from './entities/agent-token-usage.entity';
import { AgentToolCall } from './entities/agent-tool-call.entity';
import { MikroOrmGovernanceQueries } from './mikro-orm-governance-queries';
import { MikroOrmPricingStore } from './mikro-orm-pricing-store';

let orm: MikroORM;
let queries: MikroOrmGovernanceQueries;

// Inclusive range that spans the two in-range usage days (2026-07-01, 2026-07-02).
const range = { fromDay: '2026-07-01', toDay: '2026-07-03' };

beforeAll(async () => {
  orm = await MikroORM.init({
    driver: SqliteDriver,
    dbName: ':memory:',
    entities: agentEntities(),
    allowGlobalContext: true,
  });
  await ensureAgentSchema(orm);
  queries = new MikroOrmGovernanceQueries(orm.em, new MikroOrmPricingStore(orm.em));

  const em = orm.em.fork();

  // Pricing: gpt-x current 3/15; an older non-current gpt-x row must be ignored; free-y unpriced.
  const supersededPricing = em.create(AgentModelPricing, {
    id: 'price-old',
    modelId: 'gpt-x',
    inputPricePer1m: 99,
    outputPricePer1m: 99,
    effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
    isCurrent: false,
  });
  const currentPricing = em.create(AgentModelPricing, {
    id: 'price-current',
    modelId: 'gpt-x',
    inputPricePer1m: 3,
    outputPricePer1m: 15,
    effectiveFrom: new Date('2026-06-01T00:00:00.000Z'),
    isCurrent: true,
  });

  const aliceThread = em.create(AgentThread, {
    id: 'thread-alice',
    actorRef: 'alice',
    title: 'Alice chat',
    transient: false,
    summaryMessageCount: 0,
    createdAt: new Date('2026-07-01T09:00:00.000Z'),
    updatedAt: new Date('2026-07-02T09:00:00.000Z'),
  });
  const bobThread = em.create(AgentThread, {
    id: 'thread-bob',
    actorRef: 'bob',
    title: 'Bob chat',
    transient: false,
    summaryMessageCount: 0,
    createdAt: new Date('2026-07-02T09:00:00.000Z'),
    updatedAt: new Date('2026-07-02T10:00:00.000Z'),
  });

  const aliceMessage = em.create(AgentMessage, {
    id: 'msg-alice',
    thread: aliceThread,
    role: 'assistant',
    content: 'looking that up',
    createdAt: new Date('2026-07-01T09:05:00.000Z'),
  });
  const bobMessage = em.create(AgentMessage, {
    id: 'msg-bob',
    thread: bobThread,
    role: 'assistant',
    content: 'on it',
    createdAt: new Date('2026-07-02T09:05:00.000Z'),
  });

  const olderToolCall = em.create(AgentToolCall, {
    id: 'tc-search',
    message: aliceMessage,
    toolName: 'search',
    toolType: 'read',
    status: 'executed',
    createdAt: new Date('2026-07-01T09:06:00.000Z'),
  });
  const newerToolCall = em.create(AgentToolCall, {
    id: 'tc-deploy',
    message: bobMessage,
    toolName: 'deploy',
    toolType: 'action',
    status: 'pending_approval',
    createdAt: new Date('2026-07-02T09:06:00.000Z'),
  });

  // A: alice/gpt-x 2026-07-01 → cost 1*3 + 0.5*15 = 10.5
  const usageA = em.create(AgentTokenUsage, {
    id: 'usage-a',
    thread: aliceThread,
    actorRef: 'alice',
    modelId: 'gpt-x',
    purpose: 'chat',
    inputTokens: 1_000_000,
    outputTokens: 500_000,
    createdAt: new Date('2026-07-01T09:05:00.000Z'),
  });
  // B: alice/free-y (unpriced) 2026-07-02 → cost 0
  const usageB = em.create(AgentTokenUsage, {
    id: 'usage-b',
    thread: aliceThread,
    actorRef: 'alice',
    modelId: 'free-y',
    purpose: 'chat',
    inputTokens: 2_000_000,
    outputTokens: 1_000_000,
    createdAt: new Date('2026-07-02T11:00:00.000Z'),
  });
  // C: bob/gpt-x 2026-07-02 → cost 0.5*3 + 0.1*15 = 3.0
  const usageC = em.create(AgentTokenUsage, {
    id: 'usage-c',
    thread: bobThread,
    actorRef: 'bob',
    modelId: 'gpt-x',
    purpose: 'chat',
    inputTokens: 500_000,
    outputTokens: 100_000,
    createdAt: new Date('2026-07-02T09:30:00.000Z'),
  });
  // D: out-of-range (June) — excluded from every ranged aggregation.
  const usageOutOfRange = em.create(AgentTokenUsage, {
    id: 'usage-june',
    thread: aliceThread,
    actorRef: 'alice',
    modelId: 'gpt-x',
    purpose: 'chat',
    inputTokens: 9_000_000,
    outputTokens: 9_000_000,
    createdAt: new Date('2026-06-15T09:00:00.000Z'),
  });

  em.persist([
    supersededPricing,
    currentPricing,
    aliceThread,
    bobThread,
    aliceMessage,
    bobMessage,
    olderToolCall,
    newerToolCall,
    usageA,
    usageB,
    usageC,
    usageOutOfRange,
  ]);
  await em.flush();
});

afterAll(async () => {
  await orm?.close(true);
});

describe('MikroOrmGovernanceQueries (sqlite)', () => {
  it('spendByModel aggregates tokens + cost against the current pricing row, priced desc first', async () => {
    const rows = await queries.spendByModel(range);
    expect(rows).toHaveLength(2);

    const [priced, unpriced] = rows;
    expect(priced?.modelId).toBe('gpt-x');
    expect(priced?.requests).toBe(2);
    expect(priced?.inputTokens).toBe(1_500_000);
    expect(priced?.outputTokens).toBe(600_000);
    expect(priced?.costUsd).toBeCloseTo(13.5, 6);

    expect(unpriced?.modelId).toBe('free-y');
    expect(unpriced?.requests).toBe(1);
    expect(unpriced?.inputTokens).toBe(2_000_000);
    expect(unpriced?.outputTokens).toBe(1_000_000);
    expect(unpriced?.costUsd).toBe(0);
  });

  it('spendByActor rolls up per-actor tokens + cost across models', async () => {
    const rows = await queries.spendByActor(range);
    expect(rows).toHaveLength(2);

    const alice = rows.find((row) => row.actorRef === 'alice');
    expect(alice?.requests).toBe(2);
    expect(alice?.totalTokens).toBe(4_500_000);
    expect(alice?.costUsd).toBeCloseTo(10.5, 6);
    // alice's two in-range rows (usage-a, usage-b) are both on thread-alice
    expect(alice?.threadCount).toBe(1);

    const bob = rows.find((row) => row.actorRef === 'bob');
    expect(bob?.requests).toBe(1);
    expect(bob?.totalTokens).toBe(600_000);
    expect(bob?.costUsd).toBeCloseTo(3.0, 6);
    expect(bob?.threadCount).toBe(1);

    // priced highest spend sorts first
    expect(rows[0]?.actorRef).toBe('alice');
  });

  it('spendByThread rolls up per-thread tokens + cost, highest spend first, capped at limit', async () => {
    const rows = await queries.spendByThread(range, 10);
    expect(rows).toHaveLength(2);

    expect(rows[0]).toMatchObject({
      threadId: 'thread-alice',
      title: 'Alice chat',
      actorRef: 'alice',
      requests: 2,
      totalTokens: 4_500_000,
    });
    expect(rows[0]?.costUsd).toBeCloseTo(10.5, 6);

    expect(rows[1]).toMatchObject({
      threadId: 'thread-bob',
      title: 'Bob chat',
      actorRef: 'bob',
      requests: 1,
      totalTokens: 600_000,
    });
    expect(rows[1]?.costUsd).toBeCloseTo(3.0, 6);

    const capped = await queries.spendByThread(range, 1);
    expect(capped).toHaveLength(1);
    expect(capped[0]?.threadId).toBe('thread-alice');
  });

  it('usageTrend buckets tokens + cost by UTC day, ascending, excluding out-of-range rows', async () => {
    const points = await queries.usageTrend(range);
    expect(points.map((point) => point.day)).toEqual(['2026-07-01', '2026-07-02']);

    expect(points[0]?.totalTokens).toBe(1_500_000);
    expect(points[0]?.costUsd).toBeCloseTo(10.5, 6);

    expect(points[1]?.totalTokens).toBe(3_600_000);
    expect(points[1]?.costUsd).toBeCloseTo(3.0, 6);
  });

  it('recentToolCalls returns newest-first with the resolved thread id', async () => {
    const rows = await queries.recentToolCalls(10);
    expect(rows.map((row) => row.toolCallId)).toEqual(['tc-deploy', 'tc-search']);

    expect(rows[0]).toMatchObject({
      toolName: 'deploy',
      toolType: 'action',
      status: 'pending_approval',
      threadId: 'thread-bob',
    });
    expect(rows[1]).toMatchObject({ toolName: 'search', threadId: 'thread-alice' });
  });

  it('recentThreads rolls up message count + all-time tokens, newest activity first', async () => {
    const rows = await queries.recentThreads(10);
    expect(rows.map((row) => row.threadId)).toEqual(['thread-bob', 'thread-alice']);

    const alice = rows.find((row) => row.threadId === 'thread-alice');
    expect(alice?.title).toBe('Alice chat');
    expect(alice?.actorRef).toBe('alice');
    expect(alice?.messageCount).toBe(1);
    // all-time (unranged) tokens: A + B + June row
    expect(alice?.totalTokens).toBe(22_500_000);

    const bob = rows.find((row) => row.threadId === 'thread-bob');
    expect(bob?.messageCount).toBe(1);
    expect(bob?.totalTokens).toBe(600_000);
  });
});

// A self-contained ORM so the reported-cost rows never perturb the shared-seed count assertions.
describe('MikroOrmGovernanceQueries reported cost (sqlite)', () => {
  let reportedOrm: MikroORM;
  let reportedQueries: MikroOrmGovernanceQueries;
  const reportedRange = { fromDay: '2026-07-05', toDay: '2026-07-05' };

  beforeAll(async () => {
    reportedOrm = await MikroORM.init({
      driver: SqliteDriver,
      dbName: ':memory:',
      entities: agentEntities(),
      allowGlobalContext: true,
    });
    await ensureAgentSchema(reportedOrm);
    reportedQueries = new MikroOrmGovernanceQueries(
      reportedOrm.em,
      new MikroOrmPricingStore(reportedOrm.em),
    );

    const em = reportedOrm.em.fork();
    const thread = em.create(AgentThread, {
      id: 'thread-carol',
      actorRef: 'carol',
      title: 'Carol chat',
      transient: false,
      summaryMessageCount: 0,
      createdAt: new Date('2026-07-05T09:00:00.000Z'),
      updatedAt: new Date('2026-07-05T09:00:00.000Z'),
    });
    // gpt-x is priced 3/15 → estimate 1*3 + 0.5*15 = 10.5, but the gateway reported 4.2 (wins).
    const pricing = em.create(AgentModelPricing, {
      id: 'price-carol',
      modelId: 'gpt-x',
      inputPricePer1m: 3,
      outputPricePer1m: 15,
      effectiveFrom: new Date('2026-06-01T00:00:00.000Z'),
      isCurrent: true,
    });
    const priced = em.create(AgentTokenUsage, {
      id: 'usage-reported-priced',
      thread,
      actorRef: 'carol',
      modelId: 'gpt-x',
      purpose: 'chat',
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      costUsd: 4.2,
      createdAt: new Date('2026-07-05T09:05:00.000Z'),
    });
    // free-z is unpriced, yet still reports a real 1.3 — no longer collapses to 0.
    const unpriced = em.create(AgentTokenUsage, {
      id: 'usage-reported-unpriced',
      thread,
      actorRef: 'carol',
      modelId: 'free-z',
      purpose: 'chat',
      inputTokens: 2_000_000,
      outputTokens: 1_000_000,
      costUsd: 1.3,
      createdAt: new Date('2026-07-05T09:30:00.000Z'),
    });
    em.persist([thread, pricing, priced, unpriced]);
    await em.flush();
  });

  afterAll(async () => {
    await reportedOrm?.close(true);
  });

  it('spendByModel uses the reported cost for both priced and unpriced models', async () => {
    const rows = await reportedQueries.spendByModel(reportedRange);
    expect(rows.find((row) => row.modelId === 'gpt-x')?.costUsd).toBeCloseTo(4.2, 6);
    expect(rows.find((row) => row.modelId === 'free-z')?.costUsd).toBeCloseTo(1.3, 6);
  });

  it('spendByActor and usageTrend sum the reported costs', async () => {
    const byActor = await reportedQueries.spendByActor(reportedRange);
    expect(byActor.find((row) => row.actorRef === 'carol')?.costUsd).toBeCloseTo(5.5, 6);

    const points = await reportedQueries.usageTrend(reportedRange);
    expect(points).toHaveLength(1);
    expect(points[0]?.costUsd).toBeCloseTo(5.5, 6);
  });
});

// A self-contained ORM exercising cache-aware pricing (cache-write/read rates + the input fallback).
describe('MikroOrmGovernanceQueries cache pricing (sqlite)', () => {
  let cacheOrm: MikroORM;
  let cacheQueries: MikroOrmGovernanceQueries;
  const cacheRange = { fromDay: '2026-07-06', toDay: '2026-07-06' };

  beforeAll(async () => {
    cacheOrm = await MikroORM.init({
      driver: SqliteDriver,
      dbName: ':memory:',
      entities: agentEntities(),
      allowGlobalContext: true,
    });
    await ensureAgentSchema(cacheOrm);
    cacheQueries = new MikroOrmGovernanceQueries(
      cacheOrm.em,
      new MikroOrmPricingStore(cacheOrm.em),
    );

    const em = cacheOrm.em.fork();
    const thread = em.create(AgentThread, {
      id: 'thread-cache',
      actorRef: 'dave',
      title: 'Cache chat',
      transient: false,
      summaryMessageCount: 0,
      createdAt: new Date('2026-07-06T09:00:00.000Z'),
      updatedAt: new Date('2026-07-06T09:00:00.000Z'),
    });
    // priced: cache-write 3.75 (1.25×), cache-read 0.3 (0.1×); unpriced-cache model has no rates.
    const cachePricing = em.create(AgentModelPricing, {
      id: 'price-cache',
      modelId: 'gpt-x',
      inputPricePer1m: 3,
      outputPricePer1m: 15,
      cacheWritePricePer1m: 3.75,
      cacheReadPricePer1m: 0.3,
      effectiveFrom: new Date('2026-06-01T00:00:00.000Z'),
      isCurrent: true,
    });
    const noCachePricing = em.create(AgentModelPricing, {
      id: 'price-nocache',
      modelId: 'gpt-flat',
      inputPricePer1m: 3,
      outputPricePer1m: 15,
      effectiveFrom: new Date('2026-06-01T00:00:00.000Z'),
      isCurrent: true,
    });
    // gpt-x: 1M input (200k write, 300k read → 500k uncached), 500k output →
    //   0.5*3 + 0.2*3.75 + 0.3*0.3 + 0.5*15 = 9.84
    const cachedUsage = em.create(AgentTokenUsage, {
      id: 'usage-cache',
      thread,
      actorRef: 'dave',
      modelId: 'gpt-x',
      purpose: 'chat',
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      cacheWriteTokens: 200_000,
      cacheReadTokens: 300_000,
      createdAt: new Date('2026-07-06T09:05:00.000Z'),
    });
    // gpt-flat: same shape but no cache rates → all input at 3 → 1*3 + 0.5*15 = 10.5
    const flatUsage = em.create(AgentTokenUsage, {
      id: 'usage-flat',
      thread,
      actorRef: 'dave',
      modelId: 'gpt-flat',
      purpose: 'chat',
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      cacheWriteTokens: 200_000,
      cacheReadTokens: 300_000,
      createdAt: new Date('2026-07-06T09:06:00.000Z'),
    });
    em.persist([thread, cachePricing, noCachePricing, cachedUsage, flatUsage]);
    await em.flush();
  });

  afterAll(async () => {
    await cacheOrm?.close(true);
  });

  it('prices cache-write/read at their own rates and the uncached remainder at the input rate', async () => {
    const rows = await cacheQueries.spendByModel(cacheRange);
    expect(rows.find((row) => row.modelId === 'gpt-x')?.costUsd).toBeCloseTo(9.84, 6);
    // token columns unchanged — cache tokens are a subset of inputTokens
    expect(rows.find((row) => row.modelId === 'gpt-x')?.inputTokens).toBe(1_000_000);
  });

  it('falls back to the input rate for cache tokens when the pricing row has no cache rates', async () => {
    const rows = await cacheQueries.spendByModel(cacheRange);
    expect(rows.find((row) => row.modelId === 'gpt-flat')?.costUsd).toBeCloseTo(10.5, 6);
  });
});

// A self-contained ORM covering spendByThread ranking/cap and multi-thread threadCount, including a
// soft-deleted thread that must be excluded from spendByThread despite having in-range usage.
describe('MikroOrmGovernanceQueries spendByThread + threadCount (sqlite)', () => {
  let threadOrm: MikroORM;
  let threadQueries: MikroOrmGovernanceQueries;
  const threadRange = { fromDay: '2026-07-08', toDay: '2026-07-08' };

  beforeAll(async () => {
    threadOrm = await MikroORM.init({
      driver: SqliteDriver,
      dbName: ':memory:',
      entities: agentEntities(),
      allowGlobalContext: true,
    });
    await ensureAgentSchema(threadOrm);
    threadQueries = new MikroOrmGovernanceQueries(
      threadOrm.em,
      new MikroOrmPricingStore(threadOrm.em),
    );

    const em = threadOrm.em.fork();
    const pricing = em.create(AgentModelPricing, {
      id: 'price-thread',
      modelId: 'gpt-x',
      inputPricePer1m: 3,
      outputPricePer1m: 15,
      effectiveFrom: new Date('2026-06-01T00:00:00.000Z'),
      isCurrent: true,
    });

    // erin uses two threads: thread-x (highest spend) and thread-y (lower spend) → threadCount 2.
    const threadX = em.create(AgentThread, {
      id: 'thread-x',
      actorRef: 'erin',
      title: 'Thread X',
      transient: false,
      createdAt: new Date('2026-07-08T09:00:00.000Z'),
      updatedAt: new Date('2026-07-08T09:00:00.000Z'),
    });
    const threadY = em.create(AgentThread, {
      id: 'thread-y',
      actorRef: 'erin',
      title: 'Thread Y',
      transient: false,
      createdAt: new Date('2026-07-08T09:00:00.000Z'),
      updatedAt: new Date('2026-07-08T09:00:00.000Z'),
    });
    // frank uses a single, lowest-spend thread.
    const threadZ = em.create(AgentThread, {
      id: 'thread-z',
      actorRef: 'frank',
      title: 'Thread Z',
      transient: false,
      createdAt: new Date('2026-07-08T09:00:00.000Z'),
      updatedAt: new Date('2026-07-08T09:00:00.000Z'),
    });
    // gina's thread is soft-deleted — its usage must be excluded from spendByThread entirely.
    const deletedThread = em.create(AgentThread, {
      id: 'thread-deleted',
      actorRef: 'gina',
      title: 'Deleted thread',
      transient: false,
      createdAt: new Date('2026-07-08T09:00:00.000Z'),
      updatedAt: new Date('2026-07-08T09:00:00.000Z'),
      deletedAt: new Date('2026-07-08T10:00:00.000Z'),
    });

    // thread-x: 1M/500k → 1*3 + 0.5*15 = 10.5
    const usageX = em.create(AgentTokenUsage, {
      id: 'usage-x',
      thread: threadX,
      actorRef: 'erin',
      modelId: 'gpt-x',
      purpose: 'chat',
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      createdAt: new Date('2026-07-08T09:05:00.000Z'),
    });
    // thread-y: 500k/100k → 0.5*3 + 0.1*15 = 3.0
    const usageY = em.create(AgentTokenUsage, {
      id: 'usage-y',
      thread: threadY,
      actorRef: 'erin',
      modelId: 'gpt-x',
      purpose: 'chat',
      inputTokens: 500_000,
      outputTokens: 100_000,
      createdAt: new Date('2026-07-08T09:10:00.000Z'),
    });
    // thread-z: 200k/100k → 0.2*3 + 0.1*15 = 2.1
    const usageZ = em.create(AgentTokenUsage, {
      id: 'usage-z',
      thread: threadZ,
      actorRef: 'frank',
      modelId: 'gpt-x',
      purpose: 'chat',
      inputTokens: 200_000,
      outputTokens: 100_000,
      createdAt: new Date('2026-07-08T09:15:00.000Z'),
    });
    // thread-deleted: would be the highest spend of all, but must not surface anywhere.
    const usageDeleted = em.create(AgentTokenUsage, {
      id: 'usage-deleted',
      thread: deletedThread,
      actorRef: 'gina',
      modelId: 'gpt-x',
      purpose: 'chat',
      inputTokens: 2_000_000,
      outputTokens: 2_000_000,
      createdAt: new Date('2026-07-08T09:20:00.000Z'),
    });

    em.persist([
      pricing,
      threadX,
      threadY,
      threadZ,
      deletedThread,
      usageX,
      usageY,
      usageZ,
      usageDeleted,
    ]);
    await em.flush();
  });

  afterAll(async () => {
    await threadOrm?.close(true);
  });

  it('spendByThread ranks threads highest cost first and excludes soft-deleted threads', async () => {
    const rows = await threadQueries.spendByThread(threadRange, 10);
    expect(rows.map((row) => row.threadId)).toEqual(['thread-x', 'thread-y', 'thread-z']);

    expect(rows[0]).toMatchObject({ title: 'Thread X', actorRef: 'erin', requests: 1 });
    expect(rows[0]?.totalTokens).toBe(1_500_000);
    expect(rows[0]?.costUsd).toBeCloseTo(10.5, 6);

    expect(rows[1]).toMatchObject({ title: 'Thread Y', actorRef: 'erin', requests: 1 });
    expect(rows[1]?.costUsd).toBeCloseTo(3.0, 6);

    expect(rows[2]).toMatchObject({ title: 'Thread Z', actorRef: 'frank', requests: 1 });
    expect(rows[2]?.costUsd).toBeCloseTo(2.1, 6);
  });

  it('spendByThread caps at limit', async () => {
    const rows = await threadQueries.spendByThread(threadRange, 2);
    expect(rows.map((row) => row.threadId)).toEqual(['thread-x', 'thread-y']);
  });

  it('spendByActor reports threadCount across the actor distinct threads', async () => {
    const rows = await threadQueries.spendByActor(threadRange);
    expect(rows.find((row) => row.actorRef === 'erin')?.threadCount).toBe(2);
    expect(rows.find((row) => row.actorRef === 'frank')?.threadCount).toBe(1);
  });
});

// A self-contained ORM covering the five reliability (run) queries: runMetrics, runsByAgent,
// runErrors, runTrend, recentRuns. Seeds completed/failed/running runs across two agents and two
// in-range days, plus one out-of-range run that only `recentRuns` (unranged) should surface.
describe('MikroOrmGovernanceQueries run reliability (sqlite)', () => {
  let runOrm: MikroORM;
  let runQueries: MikroOrmGovernanceQueries;
  const runRange = { fromDay: '2026-07-10', toDay: '2026-07-11' };

  beforeAll(async () => {
    runOrm = await MikroORM.init({
      driver: SqliteDriver,
      dbName: ':memory:',
      entities: agentEntities(),
      allowGlobalContext: true,
    });
    await ensureAgentSchema(runOrm);
    runQueries = new MikroOrmGovernanceQueries(runOrm.em, new MikroOrmPricingStore(runOrm.em));

    const em = runOrm.em.fork();
    const threadR1 = em.create(AgentThread, {
      id: 'thread-r1',
      actorRef: 'hank',
      title: 'Hank chat',
      transient: false,
      createdAt: new Date('2026-07-10T08:00:00.000Z'),
      updatedAt: new Date('2026-07-10T10:00:00.000Z'),
    });
    const threadR2 = em.create(AgentThread, {
      id: 'thread-r2',
      actorRef: 'ivan',
      title: 'Ivan chat',
      transient: false,
      createdAt: new Date('2026-07-11T08:00:00.000Z'),
      updatedAt: new Date('2026-07-11T10:00:00.000Z'),
    });

    // run-1/run-2: agent 'researcher' on thread-r1, day 2026-07-10 — one completed, one failed.
    const run1 = em.create(AgentRun, {
      id: 'run-1',
      thread: threadR1,
      actorRef: 'hank',
      agentName: 'researcher',
      status: 'completed',
      durationMs: 100,
      retries: 1,
      startedAt: new Date('2026-07-10T09:00:00.000Z'),
      settledAt: new Date('2026-07-10T09:00:00.100Z'),
      promptHash: 'hash-run-1',
    });
    const run2 = em.create(AgentRun, {
      id: 'run-2',
      thread: threadR1,
      actorRef: 'hank',
      agentName: 'researcher',
      status: 'failed',
      durationMs: 200,
      errorCode: 'timeout',
      errorMessage: 'upstream timed out',
      retries: 0,
      startedAt: new Date('2026-07-10T10:00:00.000Z'),
      settledAt: new Date('2026-07-10T10:00:00.200Z'),
    });
    // run-3/run-4: no agentName ('(default)' bucket) on thread-r2, day 2026-07-11 — one completed,
    // one still running (unsettled — excluded from the duration percentiles and completed/failed counts).
    const run3 = em.create(AgentRun, {
      id: 'run-3',
      thread: threadR2,
      actorRef: 'ivan',
      status: 'completed',
      durationMs: 300,
      retries: 2,
      startedAt: new Date('2026-07-11T09:00:00.000Z'),
      settledAt: new Date('2026-07-11T09:00:00.300Z'),
    });
    const run4 = em.create(AgentRun, {
      id: 'run-4',
      thread: threadR2,
      actorRef: 'ivan',
      status: 'running',
      retries: 0,
      startedAt: new Date('2026-07-11T10:00:00.000Z'),
    });
    // run-5: out of `runRange` (a day earlier) — excluded from every ranged query, but `recentRuns`
    // has no range param, so it still surfaces there as the oldest row.
    const run5 = em.create(AgentRun, {
      id: 'run-5',
      thread: threadR1,
      actorRef: 'hank',
      status: 'completed',
      durationMs: 50,
      retries: 0,
      startedAt: new Date('2026-07-09T09:00:00.000Z'),
      settledAt: new Date('2026-07-09T09:00:00.050Z'),
    });

    em.persist([threadR1, threadR2, run1, run2, run3, run4, run5]);
    await em.flush();
  });

  afterAll(async () => {
    await runOrm?.close(true);
  });

  it('runMetrics aggregates counts, successRate, retries and duration percentiles over settled runs', async () => {
    const metrics = await runQueries.runMetrics(runRange);
    // run-5 is out of range; run-1..4 are in range (2 completed, 1 failed, 1 still running)
    expect(metrics.runs).toBe(4);
    expect(metrics.completed).toBe(2);
    expect(metrics.failed).toBe(1);
    expect(metrics.successRate).toBeCloseTo(0.5, 6);
    expect(metrics.retries).toBe(3); // 1 + 0 + 2 + 0
    // settled durations ascending: [100, 200, 300] (run-4 is unsettled, excluded)
    expect(metrics.durationP50Ms).toBe(200);
    expect(metrics.durationP95Ms).toBe(300);
  });

  it('runMetrics reports successRate 0 and null percentiles when there are no runs in range', async () => {
    const metrics = await runQueries.runMetrics({ fromDay: '2020-01-01', toDay: '2020-01-01' });
    expect(metrics).toEqual({
      runs: 0,
      completed: 0,
      failed: 0,
      successRate: 0,
      retries: 0,
      durationP50Ms: null,
      durationP95Ms: null,
    });
  });

  it('runsByAgent buckets by agentName, defaulting a null agentName to "(default)"', async () => {
    const rows = await runQueries.runsByAgent(runRange);
    expect(rows).toHaveLength(2);

    const researcher = rows.find((row) => row.agentName === 'researcher');
    expect(researcher).toEqual({ agentName: 'researcher', runs: 2, failed: 1, retries: 1 });

    const defaulted = rows.find((row) => row.agentName === '(default)');
    expect(defaulted).toEqual({ agentName: '(default)', runs: 2, failed: 0, retries: 2 });
  });

  it('runErrors buckets failed runs by errorCode', async () => {
    const rows = await runQueries.runErrors(runRange);
    expect(rows).toEqual([{ errorCode: 'timeout', count: 1 }]);
  });

  it('runTrend buckets runs + failures by UTC day, ascending, excluding out-of-range rows', async () => {
    const points = await runQueries.runTrend(runRange);
    expect(points).toEqual([
      { day: '2026-07-10', runs: 2, failed: 1 },
      { day: '2026-07-11', runs: 2, failed: 0 },
    ]);
  });

  it('recentRuns orders newest-first with no range filter and reports every field', async () => {
    const rows = await runQueries.recentRuns(10);
    expect(rows.map((row) => row.runId)).toEqual(['run-4', 'run-3', 'run-2', 'run-1', 'run-5']);

    const running = rows.find((row) => row.runId === 'run-4');
    expect(running).toMatchObject({
      threadId: 'thread-r2',
      actorRef: 'ivan',
      agentName: null,
      status: 'running',
      durationMs: null,
      errorCode: null,
      errorMessage: null,
      retries: 0,
    });

    const failed = rows.find((row) => row.runId === 'run-2');
    expect(failed).toMatchObject({
      threadId: 'thread-r1',
      actorRef: 'hank',
      agentName: 'researcher',
      status: 'failed',
      durationMs: 200,
      errorCode: 'timeout',
      errorMessage: 'upstream timed out',
      // run-2 was started with no promptHash
      promptHash: null,
    });

    const completed = rows.find((row) => row.runId === 'run-1');
    expect(completed?.promptHash).toBe('hash-run-1');
  });

  it('recentRuns caps at limit', async () => {
    const rows = await runQueries.recentRuns(2);
    expect(rows.map((row) => row.runId)).toEqual(['run-4', 'run-3']);
  });
});

// A self-contained ORM covering pendingApprovals (thread/message join, oldest-first, limit) and
// toolStats (call/failure/rejection counts + p95 execution latency, bucketed by tool + range).
describe('MikroOrmGovernanceQueries approvals + tool stats (sqlite)', () => {
  let toolOrm: MikroORM;
  let toolQueries: MikroOrmGovernanceQueries;

  beforeAll(async () => {
    toolOrm = await MikroORM.init({
      driver: SqliteDriver,
      dbName: ':memory:',
      entities: agentEntities(),
      allowGlobalContext: true,
    });
    await ensureAgentSchema(toolOrm);
    toolQueries = new MikroOrmGovernanceQueries(toolOrm.em, new MikroOrmPricingStore(toolOrm.em));

    const em = toolOrm.em.fork();
    const threadJudy = em.create(AgentThread, {
      id: 'thread-judy',
      actorRef: 'judy',
      title: 'Judy chat',
      transient: false,
      createdAt: new Date('2026-07-10T08:00:00.000Z'),
      updatedAt: new Date('2026-07-10T08:00:00.000Z'),
    });
    const threadKyle = em.create(AgentThread, {
      id: 'thread-kyle',
      actorRef: 'kyle',
      title: 'Kyle chat',
      transient: false,
      createdAt: new Date('2026-07-10T08:00:00.000Z'),
      updatedAt: new Date('2026-07-10T08:00:00.000Z'),
    });

    // judy's first message has an agentName; her second one has none (agentName resolves to null).
    const messageJudyA = em.create(AgentMessage, {
      id: 'msg-judy-a',
      thread: threadJudy,
      role: 'assistant',
      content: 'deploying',
      agentName: 'assistant-1',
      createdAt: new Date('2026-07-10T08:30:00.000Z'),
    });
    const messageJudyB = em.create(AgentMessage, {
      id: 'msg-judy-b',
      thread: threadJudy,
      role: 'assistant',
      content: 'restarting',
      createdAt: new Date('2026-07-10T08:31:00.000Z'),
    });
    const messageKyle = em.create(AgentMessage, {
      id: 'msg-kyle',
      thread: threadKyle,
      role: 'assistant',
      content: 'deleting',
      agentName: 'assistant-2',
      createdAt: new Date('2026-07-10T08:32:00.000Z'),
    });

    // Three pending approvals across the two threads, plus one already-executed call that must be
    // excluded. Oldest first: tc-pa-1, tc-pa-2, tc-pa-3.
    const pendingOldest = em.create(AgentToolCall, {
      id: 'tc-pa-1',
      message: messageJudyA,
      toolName: 'deploy',
      toolType: 'action',
      input: { env: 'prod' },
      status: 'pending_approval',
      createdAt: new Date('2026-07-10T09:00:00.000Z'),
    });
    const pendingMiddle = em.create(AgentToolCall, {
      id: 'tc-pa-2',
      message: messageKyle,
      toolName: 'delete',
      toolType: 'action',
      input: { id: 1 },
      status: 'pending_approval',
      createdAt: new Date('2026-07-10T10:00:00.000Z'),
    });
    const pendingNewest = em.create(AgentToolCall, {
      id: 'tc-pa-3',
      message: messageJudyB,
      toolName: 'restart',
      toolType: 'action',
      input: {},
      status: 'pending_approval',
      createdAt: new Date('2026-07-10T11:00:00.000Z'),
    });
    const alreadyExecuted = em.create(AgentToolCall, {
      id: 'tc-executed',
      message: messageJudyA,
      toolName: 'search',
      toolType: 'read',
      input: {},
      status: 'executed',
      createdAt: new Date('2026-07-10T09:30:00.000Z'),
    });

    // toolStats fixtures, in their own day range (2026-07-20/21): search/read x3 (executed +
    // auto_executed), deploy/action x2 (one failed, one rejected), notify/action x1 (executed but
    // never recorded an executionMs), plus one out-of-range search call that must be excluded.
    const search1 = em.create(AgentToolCall, {
      id: 'tc-stats-search-1',
      message: messageJudyA,
      toolName: 'search',
      toolType: 'read',
      status: 'executed',
      executionMs: 50,
      createdAt: new Date('2026-07-20T09:00:00.000Z'),
    });
    const search2 = em.create(AgentToolCall, {
      id: 'tc-stats-search-2',
      message: messageJudyA,
      toolName: 'search',
      toolType: 'read',
      status: 'executed',
      executionMs: 150,
      createdAt: new Date('2026-07-20T09:05:00.000Z'),
    });
    const search3 = em.create(AgentToolCall, {
      id: 'tc-stats-search-3',
      message: messageJudyA,
      toolName: 'search',
      toolType: 'read',
      status: 'auto_executed',
      executionMs: 250,
      createdAt: new Date('2026-07-20T09:10:00.000Z'),
    });
    const deployFailed = em.create(AgentToolCall, {
      id: 'tc-stats-deploy-1',
      message: messageJudyA,
      toolName: 'deploy',
      toolType: 'action',
      status: 'failed',
      executionMs: 500,
      createdAt: new Date('2026-07-20T10:00:00.000Z'),
    });
    const deployRejected = em.create(AgentToolCall, {
      id: 'tc-stats-deploy-2',
      message: messageJudyA,
      toolName: 'deploy',
      toolType: 'action',
      status: 'rejected',
      createdAt: new Date('2026-07-20T10:05:00.000Z'),
    });
    const notifyNoLatency = em.create(AgentToolCall, {
      id: 'tc-stats-notify-1',
      message: messageJudyA,
      toolName: 'notify',
      toolType: 'action',
      status: 'executed',
      createdAt: new Date('2026-07-21T09:00:00.000Z'),
    });
    const outOfRangeSearch = em.create(AgentToolCall, {
      id: 'tc-stats-search-out',
      message: messageJudyA,
      toolName: 'search',
      toolType: 'read',
      status: 'executed',
      executionMs: 999,
      createdAt: new Date('2026-07-19T09:00:00.000Z'),
    });

    em.persist([
      threadJudy,
      threadKyle,
      messageJudyA,
      messageJudyB,
      messageKyle,
      pendingOldest,
      pendingMiddle,
      pendingNewest,
      alreadyExecuted,
      search1,
      search2,
      search3,
      deployFailed,
      deployRejected,
      notifyNoLatency,
      outOfRangeSearch,
    ]);
    await em.flush();
  });

  afterAll(async () => {
    await toolOrm?.close(true);
  });

  it('pendingApprovals joins message→thread for title/actorRef/agentName, oldest first', async () => {
    const rows = await toolQueries.pendingApprovals(10);
    expect(rows.map((row) => row.toolCallId)).toEqual(['tc-pa-1', 'tc-pa-2', 'tc-pa-3']);

    expect(rows[0]).toMatchObject({
      toolName: 'deploy',
      input: { env: 'prod' },
      threadId: 'thread-judy',
      threadTitle: 'Judy chat',
      actorRef: 'judy',
      agentName: 'assistant-1',
    });

    expect(rows[1]).toMatchObject({
      toolName: 'delete',
      threadId: 'thread-kyle',
      threadTitle: 'Kyle chat',
      actorRef: 'kyle',
      agentName: 'assistant-2',
    });

    // judy's second message carries no agentName — resolves to null, not undefined.
    expect(rows[2]).toMatchObject({
      toolName: 'restart',
      threadId: 'thread-judy',
      agentName: null,
    });
  });

  it('pendingApprovals caps at limit, keeping the oldest', async () => {
    const rows = await toolQueries.pendingApprovals(2);
    expect(rows.map((row) => row.toolCallId)).toEqual(['tc-pa-1', 'tc-pa-2']);
  });

  it('toolStats buckets by tool+type, counts failed/rejected, and computes p95 execution latency', async () => {
    const rows = await toolQueries.toolStats({ fromDay: '2026-07-20', toDay: '2026-07-21' });
    expect(rows).toEqual([
      {
        toolName: 'search',
        toolType: 'read',
        calls: 3,
        failed: 0,
        rejected: 0,
        p95ExecutionMs: 250,
      },
      {
        toolName: 'deploy',
        toolType: 'action',
        calls: 2,
        failed: 1,
        rejected: 1,
        p95ExecutionMs: 500,
      },
      {
        toolName: 'notify',
        toolType: 'action',
        calls: 1,
        failed: 0,
        rejected: 0,
        p95ExecutionMs: null,
      },
    ]);
  });

  it('toolStats reports nothing outside the range', async () => {
    const rows = await toolQueries.toolStats({ fromDay: '2020-01-01', toDay: '2020-01-01' });
    expect(rows).toEqual([]);
  });
});

// A self-contained ORM covering toolCallsPage: real COUNT(*) + offset pagination and every where
// field, mirroring the in-memory adapter's fixtures/math.
describe('MikroOrmGovernanceQueries toolCallsPage (sqlite)', () => {
  let toolCallsPageOrm: MikroORM;
  let toolCallsPageQueries: MikroOrmGovernanceQueries;

  beforeAll(async () => {
    toolCallsPageOrm = await MikroORM.init({
      driver: SqliteDriver,
      dbName: ':memory:',
      entities: agentEntities(),
      allowGlobalContext: true,
    });
    await ensureAgentSchema(toolCallsPageOrm);
    toolCallsPageQueries = new MikroOrmGovernanceQueries(
      toolCallsPageOrm.em,
      new MikroOrmPricingStore(toolCallsPageOrm.em),
    );

    const em = toolCallsPageOrm.em.fork();

    const threadA = em.create(AgentThread, {
      id: 'paged-thread-a',
      actorRef: 'alice',
      title: 'Alice chat',
      transient: false,
      createdAt: new Date('2026-07-10T08:00:00.000Z'),
      updatedAt: new Date('2026-07-10T08:00:00.000Z'),
    });
    const threadB = em.create(AgentThread, {
      id: 'paged-thread-b',
      actorRef: 'bob',
      title: 'Bob chat',
      transient: false,
      createdAt: new Date('2026-07-10T08:00:00.000Z'),
      updatedAt: new Date('2026-07-10T08:00:00.000Z'),
    });
    const messageA = em.create(AgentMessage, {
      id: 'paged-msg-a',
      thread: threadA,
      role: 'assistant',
      content: 'x',
      createdAt: new Date('2026-07-10T08:00:00.000Z'),
    });
    const messageB = em.create(AgentMessage, {
      id: 'paged-msg-b',
      thread: threadB,
      role: 'assistant',
      content: 'y',
      createdAt: new Date('2026-07-10T08:00:00.000Z'),
    });

    // Newest-first order is tc-5, tc-4, tc-3, tc-2, tc-1.
    const toolCalls = [
      em.create(AgentToolCall, {
        id: 'tc-1',
        message: messageA,
        toolName: 'search',
        toolType: 'read',
        status: 'executed',
        createdAt: new Date('2026-07-10T09:00:00.000Z'),
      }),
      em.create(AgentToolCall, {
        id: 'tc-2',
        message: messageA,
        toolName: 'deploy',
        toolType: 'action',
        status: 'pending_approval',
        createdAt: new Date('2026-07-10T10:00:00.000Z'),
      }),
      em.create(AgentToolCall, {
        id: 'tc-3',
        message: messageB,
        toolName: 'search',
        toolType: 'read',
        status: 'failed',
        createdAt: new Date('2026-07-11T09:00:00.000Z'),
      }),
      em.create(AgentToolCall, {
        id: 'tc-4',
        message: messageB,
        toolName: 'notify',
        toolType: 'action',
        status: 'executed',
        createdAt: new Date('2026-07-12T09:00:00.000Z'),
      }),
      em.create(AgentToolCall, {
        id: 'tc-5',
        message: messageA,
        toolName: 'search',
        toolType: 'action',
        status: 'rejected',
        createdAt: new Date('2026-07-13T09:00:00.000Z'),
      }),
    ];

    em.persist([threadA, threadB, messageA, messageB, ...toolCalls]);
    await em.flush();
  });

  afterAll(async () => {
    await toolCallsPageOrm?.close(true);
  });

  it('paginates newest-first: page 2 rows + total, past-end empty page, pageSize respected', async () => {
    const page1 = await toolCallsPageQueries.toolCallsPage({ page: 1, pageSize: 2 });
    expect(page1.rows.map((row) => row.toolCallId)).toEqual(['tc-5', 'tc-4']);
    expect(page1.total).toBe(5);
    expect(page1.rows).toHaveLength(2);

    const page2 = await toolCallsPageQueries.toolCallsPage({ page: 2, pageSize: 2 });
    expect(page2.rows.map((row) => row.toolCallId)).toEqual(['tc-3', 'tc-2']);
    expect(page2.total).toBe(5);

    const page3 = await toolCallsPageQueries.toolCallsPage({ page: 3, pageSize: 2 });
    expect(page3.rows.map((row) => row.toolCallId)).toEqual(['tc-1']);

    const pastEnd = await toolCallsPageQueries.toolCallsPage({ page: 4, pageSize: 2 });
    expect(pastEnd.rows).toEqual([]);
    expect(pastEnd.total).toBe(5);
    expect(pastEnd.page).toBe(4);
    expect(pastEnd.pageSize).toBe(2);
  });

  it('filters by toolName', async () => {
    const page = await toolCallsPageQueries.toolCallsPage({
      page: 1,
      pageSize: 10,
      where: { toolName: 'search' },
    });
    expect(page.rows.map((row) => row.toolCallId)).toEqual(['tc-5', 'tc-3', 'tc-1']);
    expect(page.total).toBe(3);
  });

  it('filters by toolType', async () => {
    const page = await toolCallsPageQueries.toolCallsPage({
      page: 1,
      pageSize: 10,
      where: { toolType: 'action' },
    });
    expect(page.rows.map((row) => row.toolCallId)).toEqual(['tc-5', 'tc-4', 'tc-2']);
    expect(page.total).toBe(3);
  });

  it('filters by status', async () => {
    const page = await toolCallsPageQueries.toolCallsPage({
      page: 1,
      pageSize: 10,
      where: { status: 'executed' },
    });
    expect(page.rows.map((row) => row.toolCallId)).toEqual(['tc-4', 'tc-1']);
    expect(page.total).toBe(2);
  });

  it('filters by threadId', async () => {
    const page = await toolCallsPageQueries.toolCallsPage({
      page: 1,
      pageSize: 10,
      where: { threadId: 'paged-thread-a' },
    });
    expect(page.rows.map((row) => row.toolCallId)).toEqual(['tc-5', 'tc-2', 'tc-1']);
    expect(page.total).toBe(3);
  });

  it('filters by inclusive fromDay/toDay bounds', async () => {
    const page = await toolCallsPageQueries.toolCallsPage({
      page: 1,
      pageSize: 10,
      where: { fromDay: '2026-07-11', toDay: '2026-07-12' },
    });
    expect(page.rows.map((row) => row.toolCallId)).toEqual(['tc-4', 'tc-3']);
    expect(page.total).toBe(2);
  });

  it('combines filters (toolName + threadId)', async () => {
    const page = await toolCallsPageQueries.toolCallsPage({
      page: 1,
      pageSize: 10,
      where: { toolName: 'search', threadId: 'paged-thread-a' },
    });
    expect(page.rows.map((row) => row.toolCallId)).toEqual(['tc-5', 'tc-1']);
    expect(page.total).toBe(2);
  });

  it('an unrecognized status/toolType value never matches — empty page, not an error', async () => {
    const badStatus = await toolCallsPageQueries.toolCallsPage({
      page: 1,
      pageSize: 10,
      where: { status: 'not-a-real-status' },
    });
    expect(badStatus).toEqual({ rows: [], total: 0, page: 1, pageSize: 10 });

    const badToolType = await toolCallsPageQueries.toolCallsPage({
      page: 1,
      pageSize: 10,
      where: { toolType: 'not-a-real-type' },
    });
    expect(badToolType).toEqual({ rows: [], total: 0, page: 1, pageSize: 10 });
  });
});

// A self-contained ORM covering threadsPage: real COUNT(*) + offset pagination, every where field,
// and the soft-delete exclusion.
describe('MikroOrmGovernanceQueries threadsPage (sqlite)', () => {
  let threadsPageOrm: MikroORM;
  let threadsPageQueries: MikroOrmGovernanceQueries;

  beforeAll(async () => {
    threadsPageOrm = await MikroORM.init({
      driver: SqliteDriver,
      dbName: ':memory:',
      entities: agentEntities(),
      allowGlobalContext: true,
    });
    await ensureAgentSchema(threadsPageOrm);
    threadsPageQueries = new MikroOrmGovernanceQueries(
      threadsPageOrm.em,
      new MikroOrmPricingStore(threadsPageOrm.em),
    );

    const em = threadsPageOrm.em.fork();

    // Five threads — newest-first order is t5, t4, t3, t2, t1.
    const threads = [
      em.create(AgentThread, {
        id: 't1',
        actorRef: 'erin',
        title: 'Erin Chat One',
        transient: false,
        createdAt: new Date('2026-07-10T09:00:00.000Z'),
        updatedAt: new Date('2026-07-10T09:00:00.000Z'),
      }),
      em.create(AgentThread, {
        id: 't2',
        actorRef: 'erin',
        // Mixed case, to prove the title match is case-insensitive.
        title: 'ERIN Chat Two',
        transient: false,
        createdAt: new Date('2026-07-11T09:00:00.000Z'),
        updatedAt: new Date('2026-07-11T09:00:00.000Z'),
      }),
      em.create(AgentThread, {
        id: 't3',
        actorRef: 'frank',
        title: 'Frank Notes',
        transient: false,
        createdAt: new Date('2026-07-12T09:00:00.000Z'),
        updatedAt: new Date('2026-07-12T09:00:00.000Z'),
      }),
      em.create(AgentThread, {
        id: 't4',
        actorRef: 'frank',
        title: 'Something else',
        transient: false,
        createdAt: new Date('2026-07-13T09:00:00.000Z'),
        updatedAt: new Date('2026-07-13T09:00:00.000Z'),
      }),
      em.create(AgentThread, {
        id: 't5',
        actorRef: 'erin',
        title: 'Random Notes',
        transient: false,
        createdAt: new Date('2026-07-14T09:00:00.000Z'),
        updatedAt: new Date('2026-07-14T09:00:00.000Z'),
      }),
      // Soft-deleted — must never surface in threadsPage despite matching every filter below.
      em.create(AgentThread, {
        id: 't-deleted',
        actorRef: 'erin',
        title: 'Deleted Notes',
        transient: false,
        createdAt: new Date('2026-07-15T09:00:00.000Z'),
        updatedAt: new Date('2026-07-15T09:00:00.000Z'),
        deletedAt: new Date('2026-07-15T10:00:00.000Z'),
      }),
    ];

    em.persist(threads);
    await em.flush();
  });

  afterAll(async () => {
    await threadsPageOrm?.close(true);
  });

  it('paginates newest-first: page 2 rows + total, past-end empty page, pageSize respected', async () => {
    const page1 = await threadsPageQueries.threadsPage({ page: 1, pageSize: 2 });
    expect(page1.rows.map((row) => row.title)).toEqual(['Random Notes', 'Something else']);
    expect(page1.total).toBe(5);
    expect(page1.rows).toHaveLength(2);

    const page2 = await threadsPageQueries.threadsPage({ page: 2, pageSize: 2 });
    expect(page2.rows.map((row) => row.title)).toEqual(['Frank Notes', 'ERIN Chat Two']);
    expect(page2.total).toBe(5);

    const page3 = await threadsPageQueries.threadsPage({ page: 3, pageSize: 2 });
    expect(page3.rows.map((row) => row.title)).toEqual(['Erin Chat One']);

    const pastEnd = await threadsPageQueries.threadsPage({ page: 4, pageSize: 2 });
    expect(pastEnd.rows).toEqual([]);
    expect(pastEnd.total).toBe(5);
  });

  it('filters by actorRef', async () => {
    const page = await threadsPageQueries.threadsPage({
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
  });

  it('filters by title, case-insensitively', async () => {
    const page = await threadsPageQueries.threadsPage({
      page: 1,
      pageSize: 10,
      where: { title: 'chat' },
    });
    expect(page.rows.map((row) => row.title)).toEqual(['ERIN Chat Two', 'Erin Chat One']);
    expect(page.total).toBe(2);
  });

  it('filters by inclusive fromDay/toDay bounds', async () => {
    const page = await threadsPageQueries.threadsPage({
      page: 1,
      pageSize: 10,
      where: { fromDay: '2026-07-12', toDay: '2026-07-13' },
    });
    expect(page.rows.map((row) => row.title)).toEqual(['Something else', 'Frank Notes']);
    expect(page.total).toBe(2);
  });

  it('combines filters (actorRef + title)', async () => {
    const page = await threadsPageQueries.threadsPage({
      page: 1,
      pageSize: 10,
      where: { actorRef: 'erin', title: 'notes' },
    });
    expect(page.rows.map((row) => row.title)).toEqual(['Random Notes']);
    expect(page.total).toBe(1);
  });

  it('excludes soft-deleted threads even when every filter would otherwise match', async () => {
    const page = await threadsPageQueries.threadsPage({
      page: 1,
      pageSize: 10,
      where: { actorRef: 'erin', title: 'deleted' },
    });
    expect(page).toEqual({ rows: [], total: 0, page: 1, pageSize: 10 });
  });
});

// A self-contained ORM covering runsPage: real COUNT(*) + offset pagination and every where field.
describe('MikroOrmGovernanceQueries runsPage (sqlite)', () => {
  let runsPageOrm: MikroORM;
  let runsPageQueries: MikroOrmGovernanceQueries;

  beforeAll(async () => {
    runsPageOrm = await MikroORM.init({
      driver: SqliteDriver,
      dbName: ':memory:',
      entities: agentEntities(),
      allowGlobalContext: true,
    });
    await ensureAgentSchema(runsPageOrm);
    runsPageQueries = new MikroOrmGovernanceQueries(
      runsPageOrm.em,
      new MikroOrmPricingStore(runsPageOrm.em),
    );

    const em = runsPageOrm.em.fork();
    const runThread = em.create(AgentThread, {
      id: 'paged-run-thread',
      actorRef: 'hank',
      title: 'Hank chat',
      transient: false,
      createdAt: new Date('2026-07-10T08:00:00.000Z'),
      updatedAt: new Date('2026-07-10T08:00:00.000Z'),
    });

    // Five runs — newest-first order is r5, r4, r3, r2, r1.
    const runs = [
      em.create(AgentRun, {
        id: 'r1',
        thread: runThread,
        actorRef: 'hank',
        agentName: 'researcher',
        status: 'completed',
        durationMs: 100,
        retries: 0,
        startedAt: new Date('2026-07-10T09:00:00.000Z'),
      }),
      em.create(AgentRun, {
        id: 'r2',
        thread: runThread,
        actorRef: 'hank',
        agentName: 'researcher',
        status: 'failed',
        errorCode: 'timeout',
        retries: 0,
        startedAt: new Date('2026-07-11T09:00:00.000Z'),
      }),
      em.create(AgentRun, {
        id: 'r3',
        thread: runThread,
        actorRef: 'hank',
        status: 'completed',
        durationMs: 300,
        retries: 0,
        startedAt: new Date('2026-07-12T09:00:00.000Z'),
      }),
      em.create(AgentRun, {
        id: 'r4',
        thread: runThread,
        actorRef: 'hank',
        agentName: 'planner',
        status: 'failed',
        errorCode: 'validation',
        retries: 0,
        startedAt: new Date('2026-07-13T09:00:00.000Z'),
      }),
      em.create(AgentRun, {
        id: 'r5',
        thread: runThread,
        actorRef: 'hank',
        agentName: 'researcher',
        status: 'failed',
        errorCode: 'timeout',
        retries: 0,
        startedAt: new Date('2026-07-14T09:00:00.000Z'),
      }),
    ];

    em.persist([runThread, ...runs]);
    await em.flush();
  });

  afterAll(async () => {
    await runsPageOrm?.close(true);
  });

  it('paginates newest-first: page 2 rows + total, past-end empty page, pageSize respected', async () => {
    const page1 = await runsPageQueries.runsPage({ page: 1, pageSize: 2 });
    expect(page1.rows.map((row) => row.runId)).toEqual(['r5', 'r4']);
    expect(page1.total).toBe(5);
    expect(page1.rows).toHaveLength(2);

    const page2 = await runsPageQueries.runsPage({ page: 2, pageSize: 2 });
    expect(page2.rows.map((row) => row.runId)).toEqual(['r3', 'r2']);
    expect(page2.total).toBe(5);

    const page3 = await runsPageQueries.runsPage({ page: 3, pageSize: 2 });
    expect(page3.rows.map((row) => row.runId)).toEqual(['r1']);

    const pastEnd = await runsPageQueries.runsPage({ page: 4, pageSize: 2 });
    expect(pastEnd.rows).toEqual([]);
    expect(pastEnd.total).toBe(5);
  });

  it('filters by agentName', async () => {
    const page = await runsPageQueries.runsPage({
      page: 1,
      pageSize: 10,
      where: { agentName: 'researcher' },
    });
    expect(page.rows.map((row) => row.runId)).toEqual(['r5', 'r2', 'r1']);
    expect(page.total).toBe(3);
  });

  it('filters by status', async () => {
    const page = await runsPageQueries.runsPage({
      page: 1,
      pageSize: 10,
      where: { status: 'failed' },
    });
    expect(page.rows.map((row) => row.runId)).toEqual(['r5', 'r4', 'r2']);
    expect(page.total).toBe(3);
  });

  it('filters by errorCode', async () => {
    const page = await runsPageQueries.runsPage({
      page: 1,
      pageSize: 10,
      where: { errorCode: 'timeout' },
    });
    expect(page.rows.map((row) => row.runId)).toEqual(['r5', 'r2']);
    expect(page.total).toBe(2);
  });

  it('filters by inclusive fromDay/toDay bounds', async () => {
    const page = await runsPageQueries.runsPage({
      page: 1,
      pageSize: 10,
      where: { fromDay: '2026-07-11', toDay: '2026-07-13' },
    });
    expect(page.rows.map((row) => row.runId)).toEqual(['r4', 'r3', 'r2']);
    expect(page.total).toBe(3);
  });

  it('combines filters (agentName + status)', async () => {
    const page = await runsPageQueries.runsPage({
      page: 1,
      pageSize: 10,
      where: { agentName: 'researcher', status: 'failed' },
    });
    expect(page.rows.map((row) => row.runId)).toEqual(['r5', 'r2']);
    expect(page.total).toBe(2);
  });

  it('an unrecognized status value never matches — empty page, not an error', async () => {
    const page = await runsPageQueries.runsPage({
      page: 1,
      pageSize: 10,
      where: { status: 'not-a-real-status' },
    });
    expect(page).toEqual({ rows: [], total: 0, page: 1, pageSize: 10 });
  });
});
