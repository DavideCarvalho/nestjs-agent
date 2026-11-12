import type { TenantRowFilter } from '@dudousxd/nestjs-agent-core';
import { describe, expect, it } from 'vitest';
import { InMemoryGovernanceQueries } from './in-memory-governance-queries.js';
import { InMemoryAgentStore } from './in-memory-store.js';

const today = new Date().toISOString().slice(0, 10);
const range = { fromDay: today, toDay: today };

/** One thread, run and usage row in tenant t1, in t2 and with no tenant. */
async function seeded() {
  const store = new InMemoryAgentStore();
  const ids: Record<string, string> = {};
  for (const tenant of ['t1', 't2', null] as const) {
    const key = tenant ?? 'none';
    const actor = { id: `actor-${key}`, ...(tenant !== null ? { tenantRef: tenant } : {}) };
    const thread = await store.createThread({ actor, transient: false });
    ids[key] = thread.id;
    await store.recordRunStart({ runId: `run-${key}`, threadId: thread.id, actorRef: actor.id });
    await store.recordUsage({
      threadId: thread.id,
      actorRef: actor.id,
      modelId: 'm',
      purpose: 'chat',
      usage: { inputTokens: 10, outputTokens: 0 },
      ...(tenant !== null ? { tenantRef: tenant } : {}),
    });
  }
  return { queries: new InMemoryGovernanceQueries(store), ids };
}

const cases: { name: string; filter: TenantRowFilter; sees: string[] }[] = [
  { name: 'tenant t1', filter: { tenant: 't1', nulls: false }, sees: ['t1'] },
  { name: 'tenant t1, shared', filter: { tenant: 't1', nulls: true }, sees: ['t1', 'none'] },
  { name: 'tenantless', filter: { nulls: true }, sees: ['none'] },
];

describe('InMemoryGovernanceQueries.forTenant', () => {
  it('unscoped: every tenant', async () => {
    const { queries } = await seeded();
    expect((await queries.recentThreads(10)).length).toBe(3);
    expect((await queries.recentRuns(10)).length).toBe(3);
  });

  for (const { name, filter, sees } of cases) {
    it(`${name}: sees ${sees.join(', ')}`, async () => {
      const { queries, ids } = await seeded();
      const scoped = queries.forTenant(filter);
      const visibleIds = sees.map((key) => ids[key]).sort();

      expect((await scoped.recentThreads(10)).map((row) => row.threadId).sort()).toEqual(
        visibleIds,
      );
      expect(
        (await scoped.threadsPage({ page: 1, pageSize: 10 })).rows
          .map((row) => row.threadId)
          .sort(),
      ).toEqual(visibleIds);
      expect((await scoped.recentRuns(10)).map((row) => row.runId).sort()).toEqual(
        sees.map((key) => `run-${key}`).sort(),
      );
      expect((await scoped.spendByActor(range)).map((row) => row.actorRef).sort()).toEqual(
        sees.map((key) => `actor-${key}`).sort(),
      );
      for (const key of ['t1', 't2', 'none']) {
        const detail = await scoped.threadDetail({
          threadId: ids[key] as string,
          messageLimit: 10,
          runLimit: 10,
        });
        const run = await scoped.runDetail(`run-${key}`);
        expect(detail !== null).toBe(sees.includes(key));
        expect(run !== null).toBe(sees.includes(key));
      }
    });
  }
});
