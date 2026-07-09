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
import { AgentThread } from './entities/agent-thread.entity';
import { AgentTokenUsage } from './entities/agent-token-usage.entity';
import { AgentToolCall } from './entities/agent-tool-call.entity';
import { MikroOrmGovernanceQueries } from './mikro-orm-governance-queries';

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
  queries = new MikroOrmGovernanceQueries(orm.em);

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
    reportedQueries = new MikroOrmGovernanceQueries(reportedOrm.em);

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
    cacheQueries = new MikroOrmGovernanceQueries(cacheOrm.em);

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
    threadQueries = new MikroOrmGovernanceQueries(threadOrm.em);

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
