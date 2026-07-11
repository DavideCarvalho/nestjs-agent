// Integration: DrizzleGovernanceQueries against an in-memory SQLite (better-sqlite3, via
// drizzle-orm/better-sqlite3). Seeds a priced model (`gpt-x`, with a superseded non-current pricing
// row) and an unpriced model (`free-y`) plus an out-of-range ledger row, then asserts the
// read-model aggregations. Runs only under `pnpm test:db`.
import Database from 'better-sqlite3';
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3';
import { beforeAll, describe, expect, it } from 'vitest';
import { DrizzleGovernanceQueries } from './drizzle-governance-queries.js';
import { DrizzlePricingStore } from './drizzle-pricing-store.js';
import { ensureAgentSchema } from './ensure-schema.js';
import {
  agentMessage,
  agentModelPricing,
  agentRun,
  agentSchema,
  agentThread,
  agentTokenUsage,
  agentToolCall,
} from './schema.js';

let db: BetterSQLite3Database<typeof agentSchema>;
let queries: DrizzleGovernanceQueries;

// Inclusive range that spans the two in-range usage days (2026-07-01, 2026-07-02).
const range = { fromDay: '2026-07-01', toDay: '2026-07-03' };

beforeAll(async () => {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  db = drizzle(sqlite, { schema: agentSchema });
  await ensureAgentSchema(db);
  queries = new DrizzleGovernanceQueries(db, new DrizzlePricingStore(db));

  // Pricing: gpt-x current 3/15; an older non-current gpt-x row must be ignored; free-y unpriced.
  await db.insert(agentModelPricing).values([
    {
      id: 'price-old',
      modelId: 'gpt-x',
      inputPricePer1m: 99,
      outputPricePer1m: 99,
      effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      isCurrent: false,
    },
    {
      id: 'price-current',
      modelId: 'gpt-x',
      inputPricePer1m: 3,
      outputPricePer1m: 15,
      effectiveFrom: new Date('2026-06-01T00:00:00.000Z'),
      isCurrent: true,
    },
  ]);

  await db.insert(agentThread).values([
    {
      id: 'thread-alice',
      actorRef: 'alice',
      title: 'Alice chat',
      createdAt: new Date('2026-07-01T09:00:00.000Z'),
      updatedAt: new Date('2026-07-02T09:00:00.000Z'),
    },
    {
      id: 'thread-bob',
      actorRef: 'bob',
      title: 'Bob chat',
      createdAt: new Date('2026-07-02T09:00:00.000Z'),
      updatedAt: new Date('2026-07-02T10:00:00.000Z'),
    },
  ]);

  await db.insert(agentMessage).values([
    {
      id: 'msg-alice',
      threadId: 'thread-alice',
      role: 'assistant',
      content: 'looking that up',
      createdAt: new Date('2026-07-01T09:05:00.000Z'),
    },
    {
      id: 'msg-bob',
      threadId: 'thread-bob',
      role: 'assistant',
      content: 'on it',
      createdAt: new Date('2026-07-02T09:05:00.000Z'),
    },
  ]);

  await db.insert(agentToolCall).values([
    {
      id: 'tc-search',
      messageId: 'msg-alice',
      toolName: 'search',
      toolType: 'read',
      status: 'executed',
      createdAt: new Date('2026-07-01T09:06:00.000Z'),
    },
    {
      id: 'tc-deploy',
      messageId: 'msg-bob',
      toolName: 'deploy',
      toolType: 'action',
      status: 'pending_approval',
      createdAt: new Date('2026-07-02T09:06:00.000Z'),
    },
  ]);

  await db.insert(agentTokenUsage).values([
    // A: alice/gpt-x 2026-07-01 → cost 1*3 + 0.5*15 = 10.5
    {
      id: 'usage-a',
      threadId: 'thread-alice',
      actorRef: 'alice',
      modelId: 'gpt-x',
      purpose: 'chat',
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      createdAt: new Date('2026-07-01T09:05:00.000Z'),
    },
    // B: alice/free-y (unpriced) 2026-07-02 → cost 0
    {
      id: 'usage-b',
      threadId: 'thread-alice',
      actorRef: 'alice',
      modelId: 'free-y',
      purpose: 'chat',
      inputTokens: 2_000_000,
      outputTokens: 1_000_000,
      createdAt: new Date('2026-07-02T11:00:00.000Z'),
    },
    // C: bob/gpt-x 2026-07-02 → cost 0.5*3 + 0.1*15 = 3.0
    {
      id: 'usage-c',
      threadId: 'thread-bob',
      actorRef: 'bob',
      modelId: 'gpt-x',
      purpose: 'chat',
      inputTokens: 500_000,
      outputTokens: 100_000,
      createdAt: new Date('2026-07-02T09:30:00.000Z'),
    },
    // D: out-of-range (June) — excluded from every ranged aggregation.
    {
      id: 'usage-june',
      threadId: 'thread-alice',
      actorRef: 'alice',
      modelId: 'gpt-x',
      purpose: 'chat',
      inputTokens: 9_000_000,
      outputTokens: 9_000_000,
      createdAt: new Date('2026-06-15T09:00:00.000Z'),
    },
  ]);
});

describe('DrizzleGovernanceQueries (better-sqlite3)', () => {
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

// A self-contained db so the reported-cost rows never perturb the shared-seed count assertions.
describe('DrizzleGovernanceQueries reported cost (better-sqlite3)', () => {
  let reportedDb: BetterSQLite3Database<typeof agentSchema>;
  let reportedQueries: DrizzleGovernanceQueries;
  const reportedRange = { fromDay: '2026-07-05', toDay: '2026-07-05' };

  beforeAll(async () => {
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    reportedDb = drizzle(sqlite, { schema: agentSchema });
    await ensureAgentSchema(reportedDb);
    reportedQueries = new DrizzleGovernanceQueries(reportedDb, new DrizzlePricingStore(reportedDb));

    // gpt-x is priced 3/15 → estimate 1*3 + 0.5*15 = 10.5, but the gateway reported 4.2 (wins).
    await reportedDb.insert(agentModelPricing).values({
      id: 'price-carol',
      modelId: 'gpt-x',
      inputPricePer1m: 3,
      outputPricePer1m: 15,
      effectiveFrom: new Date('2026-06-01T00:00:00.000Z'),
      isCurrent: true,
    });
    await reportedDb.insert(agentThread).values({
      id: 'thread-carol',
      actorRef: 'carol',
      title: 'Carol chat',
      createdAt: new Date('2026-07-05T09:00:00.000Z'),
      updatedAt: new Date('2026-07-05T09:00:00.000Z'),
    });
    await reportedDb.insert(agentTokenUsage).values([
      {
        id: 'usage-reported-priced',
        threadId: 'thread-carol',
        actorRef: 'carol',
        modelId: 'gpt-x',
        purpose: 'chat',
        inputTokens: 1_000_000,
        outputTokens: 500_000,
        costUsd: 4.2,
        createdAt: new Date('2026-07-05T09:05:00.000Z'),
      },
      // free-z is unpriced, yet still reports a real 1.3 — no longer collapses to 0.
      {
        id: 'usage-reported-unpriced',
        threadId: 'thread-carol',
        actorRef: 'carol',
        modelId: 'free-z',
        purpose: 'chat',
        inputTokens: 2_000_000,
        outputTokens: 1_000_000,
        costUsd: 1.3,
        createdAt: new Date('2026-07-05T09:30:00.000Z'),
      },
    ]);
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

// A self-contained db exercising cache-aware pricing (cache-write/read rates + the input fallback).
describe('DrizzleGovernanceQueries cache pricing (better-sqlite3)', () => {
  let cacheDb: BetterSQLite3Database<typeof agentSchema>;
  let cacheQueries: DrizzleGovernanceQueries;
  const cacheRange = { fromDay: '2026-07-06', toDay: '2026-07-06' };

  beforeAll(async () => {
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    cacheDb = drizzle(sqlite, { schema: agentSchema });
    await ensureAgentSchema(cacheDb);
    cacheQueries = new DrizzleGovernanceQueries(cacheDb, new DrizzlePricingStore(cacheDb));

    // priced: cache-write 3.75 (1.25×), cache-read 0.3 (0.1×); gpt-flat has no cache rates.
    await cacheDb.insert(agentModelPricing).values([
      {
        id: 'price-cache',
        modelId: 'gpt-x',
        inputPricePer1m: 3,
        outputPricePer1m: 15,
        cacheWritePricePer1m: 3.75,
        cacheReadPricePer1m: 0.3,
        effectiveFrom: new Date('2026-06-01T00:00:00.000Z'),
        isCurrent: true,
      },
      {
        id: 'price-nocache',
        modelId: 'gpt-flat',
        inputPricePer1m: 3,
        outputPricePer1m: 15,
        effectiveFrom: new Date('2026-06-01T00:00:00.000Z'),
        isCurrent: true,
      },
    ]);
    await cacheDb.insert(agentThread).values({
      id: 'thread-cache',
      actorRef: 'dave',
      title: 'Cache chat',
      createdAt: new Date('2026-07-06T09:00:00.000Z'),
      updatedAt: new Date('2026-07-06T09:00:00.000Z'),
    });
    await cacheDb.insert(agentTokenUsage).values([
      // gpt-x: 1M input (200k write, 300k read → 500k uncached), 500k output →
      //   0.5*3 + 0.2*3.75 + 0.3*0.3 + 0.5*15 = 9.84
      {
        id: 'usage-cache',
        threadId: 'thread-cache',
        actorRef: 'dave',
        modelId: 'gpt-x',
        purpose: 'chat',
        inputTokens: 1_000_000,
        outputTokens: 500_000,
        cacheWriteTokens: 200_000,
        cacheReadTokens: 300_000,
        createdAt: new Date('2026-07-06T09:05:00.000Z'),
      },
      // gpt-flat: same shape but no cache rates → all input at 3 → 1*3 + 0.5*15 = 10.5
      {
        id: 'usage-flat',
        threadId: 'thread-cache',
        actorRef: 'dave',
        modelId: 'gpt-flat',
        purpose: 'chat',
        inputTokens: 1_000_000,
        outputTokens: 500_000,
        cacheWriteTokens: 200_000,
        cacheReadTokens: 300_000,
        createdAt: new Date('2026-07-06T09:06:00.000Z'),
      },
    ]);
  });

  it('prices cache-write/read at their own rates and the uncached remainder at the input rate', async () => {
    const rows = await cacheQueries.spendByModel(cacheRange);
    expect(rows.find((row) => row.modelId === 'gpt-x')?.costUsd).toBeCloseTo(9.84, 6);
    expect(rows.find((row) => row.modelId === 'gpt-x')?.inputTokens).toBe(1_000_000);
  });

  it('falls back to the input rate for cache tokens when the pricing row has no cache rates', async () => {
    const rows = await cacheQueries.spendByModel(cacheRange);
    expect(rows.find((row) => row.modelId === 'gpt-flat')?.costUsd).toBeCloseTo(10.5, 6);
  });
});

// A self-contained db covering spendByThread ranking/cap and multi-thread threadCount, including a
// soft-deleted thread that must be excluded from spendByThread despite having in-range usage.
describe('DrizzleGovernanceQueries spendByThread + threadCount (better-sqlite3)', () => {
  let threadDb: BetterSQLite3Database<typeof agentSchema>;
  let threadQueries: DrizzleGovernanceQueries;
  const threadRange = { fromDay: '2026-07-08', toDay: '2026-07-08' };

  beforeAll(async () => {
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    threadDb = drizzle(sqlite, { schema: agentSchema });
    await ensureAgentSchema(threadDb);
    threadQueries = new DrizzleGovernanceQueries(threadDb, new DrizzlePricingStore(threadDb));

    await threadDb.insert(agentModelPricing).values({
      id: 'price-thread',
      modelId: 'gpt-x',
      inputPricePer1m: 3,
      outputPricePer1m: 15,
      effectiveFrom: new Date('2026-06-01T00:00:00.000Z'),
      isCurrent: true,
    });

    // erin uses two threads: thread-x (highest spend) and thread-y (lower spend) → threadCount 2.
    // frank uses a single, lowest-spend thread. gina's thread is soft-deleted.
    await threadDb.insert(agentThread).values([
      {
        id: 'thread-x',
        actorRef: 'erin',
        title: 'Thread X',
        createdAt: new Date('2026-07-08T09:00:00.000Z'),
        updatedAt: new Date('2026-07-08T09:00:00.000Z'),
      },
      {
        id: 'thread-y',
        actorRef: 'erin',
        title: 'Thread Y',
        createdAt: new Date('2026-07-08T09:00:00.000Z'),
        updatedAt: new Date('2026-07-08T09:00:00.000Z'),
      },
      {
        id: 'thread-z',
        actorRef: 'frank',
        title: 'Thread Z',
        createdAt: new Date('2026-07-08T09:00:00.000Z'),
        updatedAt: new Date('2026-07-08T09:00:00.000Z'),
      },
      {
        id: 'thread-deleted',
        actorRef: 'gina',
        title: 'Deleted thread',
        createdAt: new Date('2026-07-08T09:00:00.000Z'),
        updatedAt: new Date('2026-07-08T09:00:00.000Z'),
        deletedAt: new Date('2026-07-08T10:00:00.000Z'),
      },
    ]);

    await threadDb.insert(agentTokenUsage).values([
      // thread-x: 1M/500k → 1*3 + 0.5*15 = 10.5
      {
        id: 'usage-x',
        threadId: 'thread-x',
        actorRef: 'erin',
        modelId: 'gpt-x',
        purpose: 'chat',
        inputTokens: 1_000_000,
        outputTokens: 500_000,
        createdAt: new Date('2026-07-08T09:05:00.000Z'),
      },
      // thread-y: 500k/100k → 0.5*3 + 0.1*15 = 3.0
      {
        id: 'usage-y',
        threadId: 'thread-y',
        actorRef: 'erin',
        modelId: 'gpt-x',
        purpose: 'chat',
        inputTokens: 500_000,
        outputTokens: 100_000,
        createdAt: new Date('2026-07-08T09:10:00.000Z'),
      },
      // thread-z: 200k/100k → 0.2*3 + 0.1*15 = 2.1
      {
        id: 'usage-z',
        threadId: 'thread-z',
        actorRef: 'frank',
        modelId: 'gpt-x',
        purpose: 'chat',
        inputTokens: 200_000,
        outputTokens: 100_000,
        createdAt: new Date('2026-07-08T09:15:00.000Z'),
      },
      // thread-deleted: would be the highest spend of all, but must not surface anywhere.
      {
        id: 'usage-deleted',
        threadId: 'thread-deleted',
        actorRef: 'gina',
        modelId: 'gpt-x',
        purpose: 'chat',
        inputTokens: 2_000_000,
        outputTokens: 2_000_000,
        createdAt: new Date('2026-07-08T09:20:00.000Z'),
      },
    ]);
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

// A self-contained db covering the five reliability (run) queries: runMetrics, runsByAgent,
// runErrors, runTrend, recentRuns. Seeds completed/failed/running runs across two agents and two
// in-range days, plus one out-of-range run that only `recentRuns` (unranged) should surface.
describe('DrizzleGovernanceQueries run reliability (better-sqlite3)', () => {
  let runDb: BetterSQLite3Database<typeof agentSchema>;
  let runQueries: DrizzleGovernanceQueries;
  const runRange = { fromDay: '2026-07-10', toDay: '2026-07-11' };

  beforeAll(async () => {
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    runDb = drizzle(sqlite, { schema: agentSchema });
    await ensureAgentSchema(runDb);
    runQueries = new DrizzleGovernanceQueries(runDb, new DrizzlePricingStore(runDb));

    await runDb.insert(agentThread).values([
      {
        id: 'thread-r1',
        actorRef: 'hank',
        title: 'Hank chat',
        createdAt: new Date('2026-07-10T08:00:00.000Z'),
        updatedAt: new Date('2026-07-10T10:00:00.000Z'),
      },
      {
        id: 'thread-r2',
        actorRef: 'ivan',
        title: 'Ivan chat',
        createdAt: new Date('2026-07-11T08:00:00.000Z'),
        updatedAt: new Date('2026-07-11T10:00:00.000Z'),
      },
    ]);

    await runDb.insert(agentRun).values([
      // run-1/run-2: agent 'researcher' on thread-r1, day 2026-07-10 — one completed, one failed.
      {
        id: 'run-1',
        threadId: 'thread-r1',
        actorRef: 'hank',
        agentName: 'researcher',
        status: 'completed',
        durationMs: 100,
        retries: 1,
        startedAt: new Date('2026-07-10T09:00:00.000Z'),
        settledAt: new Date('2026-07-10T09:00:00.100Z'),
      },
      {
        id: 'run-2',
        threadId: 'thread-r1',
        actorRef: 'hank',
        agentName: 'researcher',
        status: 'failed',
        durationMs: 200,
        errorCode: 'timeout',
        errorMessage: 'upstream timed out',
        retries: 0,
        startedAt: new Date('2026-07-10T10:00:00.000Z'),
        settledAt: new Date('2026-07-10T10:00:00.200Z'),
      },
      // run-3/run-4: no agentName ('(default)' bucket) on thread-r2, day 2026-07-11 — one completed,
      // one still running (unsettled — excluded from the duration percentiles and completed/failed counts).
      {
        id: 'run-3',
        threadId: 'thread-r2',
        actorRef: 'ivan',
        status: 'completed',
        durationMs: 300,
        retries: 2,
        startedAt: new Date('2026-07-11T09:00:00.000Z'),
        settledAt: new Date('2026-07-11T09:00:00.300Z'),
      },
      {
        id: 'run-4',
        threadId: 'thread-r2',
        actorRef: 'ivan',
        status: 'running',
        retries: 0,
        startedAt: new Date('2026-07-11T10:00:00.000Z'),
      },
      // run-5: out of `runRange` (a day earlier) — excluded from every ranged query, but `recentRuns`
      // has no range param, so it still surfaces there as the oldest row.
      {
        id: 'run-5',
        threadId: 'thread-r1',
        actorRef: 'hank',
        status: 'completed',
        durationMs: 50,
        retries: 0,
        startedAt: new Date('2026-07-09T09:00:00.000Z'),
        settledAt: new Date('2026-07-09T09:00:00.050Z'),
      },
    ]);
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
    });
  });

  it('recentRuns caps at limit', async () => {
    const rows = await runQueries.recentRuns(2);
    expect(rows.map((row) => row.runId)).toEqual(['run-4', 'run-3']);
  });
});
