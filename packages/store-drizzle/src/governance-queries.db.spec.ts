// Integration: DrizzleGovernanceQueries against an in-memory SQLite (better-sqlite3, via
// drizzle-orm/better-sqlite3). Seeds a priced model (`gpt-x`, with a superseded non-current pricing
// row) and an unpriced model (`free-y`) plus an out-of-range ledger row, then asserts the
// read-model aggregations. Runs only under `pnpm test:db`.
import Database from 'better-sqlite3';
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3';
import { beforeAll, describe, expect, it } from 'vitest';
import { DrizzleGovernanceQueries } from './drizzle-governance-queries.js';
import { ensureAgentSchema } from './ensure-schema.js';
import {
  agentMessage,
  agentModelPricing,
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
  queries = new DrizzleGovernanceQueries(db);

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
      persona: 'default',
      createdAt: new Date('2026-07-01T09:00:00.000Z'),
      updatedAt: new Date('2026-07-02T09:00:00.000Z'),
    },
    {
      id: 'thread-bob',
      actorRef: 'bob',
      title: 'Bob chat',
      persona: 'default',
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

    const bob = rows.find((row) => row.actorRef === 'bob');
    expect(bob?.requests).toBe(1);
    expect(bob?.totalTokens).toBe(600_000);
    expect(bob?.costUsd).toBeCloseTo(3.0, 6);

    expect(rows[0]?.actorRef).toBe('alice');
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
    reportedQueries = new DrizzleGovernanceQueries(reportedDb);

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
      persona: 'default',
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
