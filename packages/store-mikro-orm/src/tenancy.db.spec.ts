// Integration: the tenancy seams of MikroOrmAgentStore / MikroOrmGovernanceQueries — tenant usage
// windows, the tenant of a thread/run/tool call, and the matching rule pushed into SQL — on SQLite,
// Postgres and MySQL. Runs only under `pnpm test:db`.
import type { TenantRowFilter } from '@dudousxd/nestjs-agent-core';
import type { MikroORM } from '@mikro-orm/sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureAgentSchema } from './ensure-schema';
import { MikroOrmAgentStore } from './mikro-orm-agent-store';
import { MikroOrmGovernanceQueries } from './mikro-orm-governance-queries';
import { MikroOrmPricingStore } from './mikro-orm-pricing-store';
import { describeEachDialect, indexesOf, openFreshOrm } from './testing/real-db';

const today = new Date().toISOString().slice(0, 10);
const range = { fromDay: today, toDay: today };
const KEYS = ['t1', 't2', 'none'] as const;
type Key = (typeof KEYS)[number];

describeEachDialect('MikroORM tenancy', (dialect) => {
  let orm: MikroORM;
  let store: MikroOrmAgentStore;
  let queries: MikroOrmGovernanceQueries;
  const threads = {} as Record<Key, string>;

  beforeAll(async () => {
    orm = await openFreshOrm(dialect, {});
    await ensureAgentSchema(orm);
    store = new MikroOrmAgentStore(orm.em);
    queries = new MikroOrmGovernanceQueries(orm.em, new MikroOrmPricingStore(orm.em));
    // One thread per tenant (and one with none), each with a run, a pending tool call and usage.
    for (const key of KEYS) {
      const tenantRef = key === 'none' ? undefined : key;
      const actor = { id: `actor-${key}`, ...(tenantRef ? { tenantRef } : {}) };
      const thread = await store.createThread({ actor, transient: false });
      threads[key] = thread.id;
      await store.setActiveStream(thread.id, `run-${key}`);
      await store.recordRunStart({ runId: `run-${key}`, threadId: thread.id, actorRef: actor.id });
      const message = await store.appendMessage({
        threadId: thread.id,
        role: 'assistant',
        content: key,
      });
      await store.recordToolCall({
        toolCallId: `call-${key}`,
        messageId: message.id,
        toolName: 'refund',
        toolType: 'action',
        input: {},
        status: 'pending_approval',
        runId: `run-${key}`,
      });
      await store.recordUsage({
        threadId: thread.id,
        actorRef: actor.id,
        modelId: 'm',
        purpose: 'chat',
        usage: { inputTokens: 10, outputTokens: 0 },
        ...(tenantRef ? { tenantRef } : {}),
      });
    }
    // A second actor in t1, and t1 spend outside any thread.
    await store.recordUsage({
      actorRef: 'actor-x',
      modelId: 'm',
      purpose: 'external',
      usage: { inputTokens: 5, outputTokens: 0 },
      tenantRef: 't1',
    });
  });

  afterAll(async () => {
    await orm?.close(true);
  });

  it('indexes the ledger by (tenant_ref, created_at)', async () => {
    expect((await indexesOf(orm, 'agent_token_usage')).map((index) => index.name)).toContain(
      'agent_token_usage_tenant_created_idx',
    );
  });

  it('sums the usage windows of a tenant, or of one actor in it', async () => {
    const [tenant] = await store.usageWindowsForTenant('t1', [range]);
    expect(tenant?.usedTokens).toBe(15);
    const [own] = await store.usageWindowsForTenant('t1', [range], 'actor-t1');
    expect(own?.usedTokens).toBe(10);
    const [none] = await store.usageWindowsForTenant('t3', [range]);
    expect(none?.usedTokens).toBe(0);
  });

  it('tells the tenant of a thread, a streaming run and a tool call', async () => {
    expect(await store.tenantOf({ threadId: threads.t1 })).toEqual({ tenantRef: 't1' });
    expect(await store.tenantOf({ runId: 'run-t2' })).toEqual({ tenantRef: 't2' });
    expect(await store.tenantOf({ toolCallId: 'call-none' })).toEqual({ tenantRef: null });
    expect(await store.tenantOf({ threadId: 'missing' })).toBeNull();
  });

  const cases: { name: string; filter: TenantRowFilter; sees: Key[] }[] = [
    { name: 'tenant t1', filter: { tenant: 't1', nulls: false }, sees: ['t1'] },
    { name: 'tenant t1, shared', filter: { tenant: 't1', nulls: true }, sees: ['t1', 'none'] },
    { name: 'tenantless', filter: { nulls: true }, sees: ['none'] },
  ];

  for (const { name, filter, sees } of cases) {
    describe(name, () => {
      it('lists only the threads the filter may see', async () => {
        for (const key of KEYS) {
          const listed = await store.listThreadsForTenant(`actor-${key}`, filter);
          expect(listed.map((thread) => thread.id)).toEqual(
            sees.includes(key) ? [threads[key]] : [],
          );
        }
      });

      it('narrows every governance read', async () => {
        const scoped = queries.forTenant(filter);
        const sorted = (values: string[]) => [...values].sort();
        const expected = sorted(sees.map((key) => threads[key]));
        expect(sorted((await scoped.recentThreads(10)).map((row) => row.threadId))).toEqual(
          expected,
        );
        expect(
          sorted((await scoped.threadsPage({ page: 1, pageSize: 10 })).rows.map((r) => r.threadId)),
        ).toEqual(expected);
        expect(sorted((await scoped.recentRuns(10)).map((row) => row.runId))).toEqual(
          sorted(sees.map((key) => `run-${key}`)),
        );
        expect((await scoped.runsPage({ page: 1, pageSize: 10 })).total).toBe(sees.length);
        expect((await scoped.runMetrics(range)).runs).toBe(sees.length);
        expect(sorted((await scoped.recentToolCalls(10)).map((row) => row.toolCallId))).toEqual(
          sorted(sees.map((key) => `call-${key}`)),
        );
        expect((await scoped.toolCallsPage({ page: 1, pageSize: 10 })).total).toBe(sees.length);
        expect((await scoped.pendingApprovals(10)).length).toBe(sees.length);
        expect((await scoped.approvalsPage({ page: 1, pageSize: 10 })).total).toBe(sees.length);
        expect((await scoped.toolStats(range))[0]?.calls ?? 0).toBe(sees.length);
        const actors = sorted((await scoped.spendByActor(range)).map((row) => row.actorRef));
        expect(actors).toEqual(
          sorted([
            ...sees.map((key) => `actor-${key}`),
            ...(filter.tenant === 't1' ? ['actor-x'] : []),
          ]),
        );
        for (const key of KEYS) {
          const visible = sees.includes(key);
          expect((await scoped.runDetail(`run-${key}`)) !== null).toBe(visible);
          expect(
            (await scoped.threadDetail({
              threadId: threads[key],
              messageLimit: 5,
              runLimit: 5,
            })) !== null,
          ).toBe(visible);
        }
      });
    });
  }

  it('unscoped reads see every tenant', async () => {
    expect((await queries.recentThreads(10)).length).toBe(3);
    expect((await queries.runsPage({ page: 1, pageSize: 10 })).total).toBe(3);
  });
});
