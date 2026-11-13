import type { Actor, AgentRunner, AgentStore, TenancyOption } from '@dudousxd/nestjs-agent-core';
import { InMemoryAgentStore } from '@dudousxd/nestjs-agent-testing';
import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { AgentDepsFactory } from './agent-deps.factory.js';
import { AgentService } from './agent.service.js';
import { LedgerQuotaProvider } from './ledger-quota-provider.js';
import { ActionProposalService } from './proposals/action-proposal.service.js';
import { tenantFillingResolver } from './resolver/tenant-filling-resolver.js';

const runner: AgentRunner = {
  start: async () => ({ runId: 'run-x' }),
  signal: async () => undefined,
  cancel: async () => undefined,
};
const deps = { forAgent: () => ({}) } as unknown as AgentDepsFactory;

/** The context's `TenantRequiredError`: a 403 with `code: 'E_TENANT_REQUIRED'`. */
class TenantRequiredError extends ForbiddenException {
  readonly code = 'E_TENANT_REQUIRED';
}

interface Level {
  id: string;
  kind: string;
}

/** The index of the most specific level whose kind is listed, else -1. */
function lastIndexOfKind(chain: Level[], kinds: string[] | undefined): number {
  for (let i = chain.length - 1; i >= 0; i--) {
    if (kinds?.includes((chain[i] as Level).kind)) return i;
  }
  return -1;
}

/**
 * A structural accessor that behaves like `@dudousxd/nestjs-context` 2.1: the request's tenant is a
 * chain (root first), `kinds` matches its most specific listed level, and `required` throws.
 */
function context21(required = false) {
  const state: { chain: Level[] | null } = { chain: null };
  return {
    state,
    in(...chain: Level[]) {
      state.chain = chain.length === 0 ? null : chain;
    },
    accessor: {
      tenancy: () => ({ enabled: true, required }),
      tenantFilter(options?: { kinds?: string[]; required?: boolean }) {
        const chain = state.chain;
        const matched =
          chain === null
            ? -1
            : options?.kinds === undefined
              ? chain.length - 1
              : lastIndexOfKind(chain, options.kinds);
        if (chain === null || matched < 0) {
          if (options?.required ?? required) throw new TenantRequiredError('tenant required');
          return { mode: 'tenantless' as const };
        }
        const level = chain[matched] as Level;
        return {
          mode: 'tenant' as const,
          tenant: { ...level, source: 'app' },
          chain: chain.slice(0, matched + 1),
        };
      },
    },
  };
}

const C1 = { id: 'C1', kind: 'clinic' };
const U1 = { id: 'U1', kind: 'unit' };
const U2 = { id: 'U2', kind: 'unit' };
const C9 = { id: 'C9', kind: 'clinic' };
const U9 = { id: 'U9', kind: 'unit' };
const byClinic: TenancyOption = { kinds: ['clinic'] };

function service(store: AgentStore, accessor: unknown, tenancy: TenancyOption = 'inherit') {
  return new AgentService(
    runner,
    store,
    deps,
    undefined,
    undefined,
    undefined,
    { tenancy },
    undefined,
    undefined,
    accessor,
  );
}

const resolve = async (
  ctx: ReturnType<typeof context21>,
  tenancy: TenancyOption,
  actor: Actor = { id: 'alice' },
) => tenantFillingResolver({ resolve: () => actor }, tenancy, ctx.accessor).resolve({});

describe('chain levels', () => {
  it("tenantRef is the matched level: kinds ['clinic'] gives a unit's request its clinic", async () => {
    const ctx = context21();
    ctx.in(C1, U1);
    expect(await resolve(ctx, byClinic)).toEqual({ id: 'alice', tenantRef: 'C1' });
    expect(await resolve(ctx, { kinds: ['unit'] })).toEqual({ id: 'alice', tenantRef: 'U1' });
    expect(await resolve(ctx, 'inherit')).toEqual({ id: 'alice', tenantRef: 'U1' });
  });

  it("thread reads: every unit of the clinic shares the clinic's threads, another clinic does not", async () => {
    const store = new InMemoryAgentStore();
    const ctx = context21();
    const agent = service(store, ctx.accessor, byClinic);
    ctx.in(C1, U1);
    const thread = await store.createThread({ actor: await resolve(ctx, byClinic) });

    ctx.in(C1, U2);
    const sibling = await resolve(ctx, byClinic);
    expect((await agent.listThreads(sibling)).map((t) => t.id)).toEqual([thread.id]);
    expect(await agent.getThread(sibling, thread.id)).not.toBeNull();

    ctx.in(C9, U9);
    const stranger = await resolve(ctx, byClinic);
    expect(await agent.listThreads(stranger)).toEqual([]);
    await expect(agent.getThread(stranger, thread.id)).rejects.toMatchObject({ status: 404 });
  });

  it("quota per 'tenant' sums the clinic's spend across its units", async () => {
    const store = new InMemoryAgentStore();
    const ctx = context21();
    const agent = service(store, ctx.accessor, byClinic);
    for (const [unit, actor, tokens] of [
      [U1, 'alice', 100],
      [U2, 'bob', 50],
    ] as const) {
      ctx.in(C1, unit);
      await agent.recordUsage(
        { actorRef: actor, feature: 'transcription', inputTokens: tokens },
        { throwOnError: true },
      );
    }
    ctx.in(C9, U9);
    await agent.recordUsage(
      { actorRef: 'alice', feature: 'transcription', inputTokens: 7 },
      { throwOnError: true },
    );
    expect(store.governanceUsage().map((row) => row.tenantRef)).toEqual(['C1', 'C1', 'C9']);

    ctx.in(C1, U2);
    const actor = await resolve(ctx, byClinic);
    const day = async (per: 'tenant' | 'actor-in-tenant') =>
      (await new LedgerQuotaProvider(store, {}, { per }).report({ actor })).windows.find(
        (w) => w.period === 'day',
      )?.usedTokens;
    expect(await day('tenant')).toBe(150);
    expect(await day('actor-in-tenant')).toBe(100);
  });
});

describe('required', () => {
  it('a read with no tenant answers 403 E_TENANT_REQUIRED instead of running tenantless', async () => {
    const store = new InMemoryAgentStore();
    const ctx = context21(true);
    const agent = service(store, ctx.accessor);
    const actor = await resolve(ctx, 'inherit');
    expect(actor).toEqual({ id: 'alice' });
    await expect(agent.listThreads(actor)).rejects.toMatchObject({
      status: 403,
      code: 'E_TENANT_REQUIRED',
    });
  });

  it('a new thread with no tenant is refused before anything is written', async () => {
    const store = new InMemoryAgentStore();
    const ctx = context21(true);
    const agent = service(store, ctx.accessor);
    await expect(
      agent.chat({ actor: { id: 'alice' }, message: 'hi' } as never),
    ).rejects.toMatchObject({ code: 'E_TENANT_REQUIRED' });
    expect(await store.listThreads('alice')).toEqual([]);
  });

  it('an actor whose resolver named its tenant needs none from the context', async () => {
    const store = new InMemoryAgentStore();
    const ctx = context21(true);
    const agent = service(store, ctx.accessor);
    const actor = await resolve(ctx, 'inherit', { id: 'alice', tenantRef: 'C1' });
    const thread = await store.createThread({ actor });
    expect((await agent.listThreads(actor)).map((t) => t.id)).toEqual([thread.id]);
    const proposals = new ActionProposalService(store, { tenancy: 'inherit' }, ctx.accessor);
    await expect(proposals.listPage(thread.id, actor)).resolves.toEqual(
      expect.objectContaining({ items: [] }),
    );
  });

  it('the agent can opt out with its own `required: false`', async () => {
    const ctx = context21(true);
    const agent = service(new InMemoryAgentStore(), ctx.accessor, { required: false });
    await expect(agent.listThreads({ id: 'alice' })).resolves.toEqual([]);
  });

  it('usage recording never throws: it runs from workers, durable turns and schedules too', async () => {
    const store = new InMemoryAgentStore();
    const ctx = context21(true);
    const agent = service(store, ctx.accessor);
    await expect(
      agent.recordUsage({ actorRef: 'alice', feature: 'transcription' }, { throwOnError: true }),
    ).resolves.toMatchObject({ recorded: true });
    expect(store.governanceUsage().map((row) => row.tenantRef)).toEqual([undefined]);
  });
});
