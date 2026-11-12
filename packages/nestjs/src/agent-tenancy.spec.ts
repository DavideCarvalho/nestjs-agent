import type {
  Actor,
  AgentRunner,
  AgentStore,
  ContextTenantFilter,
  TenancyOption,
} from '@dudousxd/nestjs-agent-core';
import { InMemoryAgentStore } from '@dudousxd/nestjs-agent-testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { AgentDepsFactory } from './agent-deps.factory.js';
import { AgentService } from './agent.service.js';
import { LedgerQuotaProvider } from './ledger-quota-provider.js';
import { ActionProposalService } from './proposals/action-proposal.service.js';
import { AnonymousActorResolver } from './resolver/anonymous-actor-resolver.js';
import { tenantFillingResolver } from './resolver/tenant-filling-resolver.js';
import { RunNotActiveException } from './run-not-active.exception.js';

const runner: AgentRunner = {
  start: async () => ({ runId: 'run-x' }),
  signal: async () => undefined,
  cancel: async () => undefined,
};

const deps = { forAgent: () => ({}) } as unknown as AgentDepsFactory;

/** A structural `@dudousxd/nestjs-context` accessor whose switch and filter a test can move. */
function context(enabled = true) {
  const state: { enabled: boolean; filter: ContextTenantFilter } = {
    enabled,
    filter: { mode: 'system' },
  };
  return {
    state,
    as(id: string | null) {
      state.filter =
        id === null
          ? { mode: 'tenantless' }
          : { mode: 'tenant', tenant: { id, kind: 'organization', source: 'app' } };
    },
    accessor: {
      tenancy: () => ({ enabled: state.enabled }),
      tenantFilter: () => state.filter,
    },
  };
}

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

const alice = (tenantRef?: string): Actor => ({
  id: 'alice',
  ...(tenantRef !== undefined ? { tenantRef } : {}),
});

/** Alice's threads in tenant t1, in t2 and with no tenant, plus a run streaming in each. */
async function seeded() {
  const store = new InMemoryAgentStore();
  const ids: Record<'t1' | 't2' | 'none', string> = { t1: '', t2: '', none: '' };
  for (const key of ['t1', 't2', 'none'] as const) {
    const thread = await store.createThread({
      actor: key === 'none' ? alice() : alice(key),
      transient: false,
    });
    await store.setActiveStream(thread.id, `run-${key}`);
    ids[key] = thread.id;
  }
  return { store, ids };
}

describe('tenancy off', () => {
  it('reads exactly as before: no tenant check, no tenant lookup', async () => {
    const { store, ids } = await seeded();
    const tenantOf = vi.spyOn(store, 'tenantOf');
    for (const accessor of [undefined, context(false).accessor, { traceId: () => undefined }]) {
      const agent = service(store, accessor);
      expect((await agent.listThreads(alice('t1'))).map((t) => t.id).sort()).toEqual(
        Object.values(ids).sort(),
      );
      await expect(agent.getThread(alice('t1'), ids.t2)).resolves.not.toBeNull();
    }
    const off = context(true);
    off.as('t1');
    const optedOut = service(store, off.accessor, false);
    await expect(optedOut.getThread(alice(), ids.t2)).resolves.not.toBeNull();
    expect(tenantOf).not.toHaveBeenCalled();
    // Another actor's thread is still a 403, as before.
    await expect(service(store, undefined).getThread({ id: 'bob' }, ids.t1)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});

describe('the matching rule on thread and run reads', () => {
  const cases: {
    name: string;
    request: string | null | 'all';
    tenancy?: TenancyOption;
    sees: ('t1' | 't2' | 'none')[];
  }[] = [
    { name: 'tenant t1', request: 't1', sees: ['t1'] },
    {
      name: 'tenant t1, nullRows shared',
      request: 't1',
      tenancy: { nullRows: 'shared' },
      sees: ['t1', 'none'],
    },
    { name: 'tenantless', request: null, sees: ['none'] },
    { name: 'allTenants', request: 'all', sees: ['t1', 't2', 'none'] },
  ];

  for (const { name, request, tenancy, sees } of cases) {
    it(`${name}: sees ${sees.join(', ')}; anything else is not found`, async () => {
      const { store, ids } = await seeded();
      const ctx = context();
      if (request === 'all') ctx.state.filter = { mode: 'all' };
      else ctx.as(request);
      const agent = service(store, ctx.accessor, tenancy);
      // The context tenant, as the tenant-filling resolver would have stamped it.
      const actor = alice(typeof request === 'string' && request !== 'all' ? request : undefined);

      const listed = (await agent.listThreads(actor)).map((t) => t.id).sort();
      expect(listed).toEqual(sees.map((key) => ids[key]).sort());

      for (const key of ['t1', 't2', 'none'] as const) {
        const threadId = ids[key];
        if (sees.includes(key)) {
          await expect(agent.getThread(actor, threadId)).resolves.not.toBeNull();
          await expect(agent.cancel(actor, `run-${key}`)).resolves.toBeUndefined();
          await expect(agent.assertResumable(actor, `run-${key}`)).resolves.toBeUndefined();
        } else {
          await expect(agent.getThread(actor, threadId)).rejects.toBeInstanceOf(NotFoundException);
          await expect(agent.deleteThread(actor, threadId)).rejects.toBeInstanceOf(
            NotFoundException,
          );
          await expect(agent.forkThread(actor, threadId, 'm')).rejects.toBeInstanceOf(
            NotFoundException,
          );
          await expect(
            agent.forkThread(actor, threadId, 'm', { authorized: true }),
          ).rejects.toBeInstanceOf(NotFoundException);
          await expect(agent.cancel(actor, `run-${key}`)).rejects.toBeInstanceOf(NotFoundException);
          await expect(agent.assertResumable(actor, `run-${key}`)).rejects.toBeInstanceOf(
            RunNotActiveException,
          );
        }
      }
    });
  }

  it('answers 404, never 403, for another actor’s thread in another tenant', async () => {
    const { store, ids } = await seeded();
    const ctx = context();
    ctx.as('t2');
    const agent = service(store, ctx.accessor);
    await expect(agent.getThread({ id: 'bob', tenantRef: 't2' }, ids.t1)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    // Same tenant, other actor: still the ownership 403.
    await expect(agent.getThread({ id: 'bob', tenantRef: 't2' }, ids.t2)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('a tenantRef the resolver set wins over the context tenant', async () => {
    const { store, ids } = await seeded();
    const ctx = context();
    ctx.as('t1');
    const agent = service(store, ctx.accessor);
    await expect(agent.getThread(alice('t2'), ids.t2)).resolves.not.toBeNull();
    await expect(agent.getThread(alice('t2'), ids.t1)).rejects.toBeInstanceOf(NotFoundException);
    expect((await agent.listThreads(alice('t2'))).map((t) => t.id)).toEqual([ids.t2]);
  });

  it('action proposals: another tenant’s thread is not found under tenancy', async () => {
    const { store, ids } = await seeded();
    const ctx = context();
    ctx.as('t2');
    const proposals = new ActionProposalService(store, { tenancy: 'inherit' }, ctx.accessor);
    await expect(proposals.listPage(ids.t1, alice('t2'))).rejects.toBeInstanceOf(NotFoundException);
    await expect(proposals.listPage(ids.t2, alice('t2'))).resolves.toEqual(
      expect.objectContaining({ items: [] }),
    );
    // Tenancy off: the existing tenant equality, a 403.
    const off = new ActionProposalService(store, {});
    await expect(off.listPage(ids.t1, alice('t2'))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('the console approval path checks the request tenant', async () => {
    const store = new InMemoryAgentStore();
    const thread = await store.createThread({ actor: alice('t1') });
    const message = await store.appendMessage({
      threadId: thread.id,
      role: 'assistant',
      content: '',
    });
    await store.recordToolCall({
      toolCallId: 'call-1',
      messageId: message.id,
      toolName: 'refund',
      toolType: 'action',
      input: {},
      status: 'pending_approval',
    });
    const ctx = context();
    ctx.as('t2');
    const agent = service(store, ctx.accessor);
    await expect(agent.assertToolCallInRequestTenant('call-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    ctx.as('t1');
    await expect(agent.assertToolCallInRequestTenant('call-1')).resolves.toBeUndefined();
  });
});

describe('the actor resolver', () => {
  it('fills tenantRef from the context tenant when the resolver leaves it empty', async () => {
    const ctx = context();
    ctx.as('t1');
    const resolver = tenantFillingResolver(
      { resolve: () => ({ id: 'u1' }) },
      'inherit',
      ctx.accessor,
    );
    expect(await resolver.resolve({})).toEqual({ id: 'u1', tenantRef: 't1' });
  });

  it('a resolver that sets tenantRef wins', async () => {
    const ctx = context();
    ctx.as('t1');
    const resolver = tenantFillingResolver(
      { resolve: async () => ({ id: 'u1', tenantRef: 'clinic-9' }) },
      'inherit',
      ctx.accessor,
    );
    expect(await resolver.resolve({})).toEqual({ id: 'u1', tenantRef: 'clinic-9' });
  });

  it('changes nothing with tenancy off, and `false` returns the resolver itself', async () => {
    const inner = { resolve: () => ({ id: 'u1' }) };
    const ctx = context(false);
    ctx.as('t1');
    expect(await tenantFillingResolver(inner, 'inherit', ctx.accessor).resolve({})).toEqual({
      id: 'u1',
    });
    expect(await tenantFillingResolver(inner, 'inherit', undefined).resolve({})).toEqual({
      id: 'u1',
    });
    expect(tenantFillingResolver(inner, false, ctx.accessor)).toBe(inner);
  });

  it('still reads as the resolver it wraps', () => {
    const wrapped = tenantFillingResolver(new AnonymousActorResolver(), 'inherit', undefined);
    expect(wrapped).toBeInstanceOf(AnonymousActorResolver);
  });
});

describe('recordUsage', () => {
  it('defaults tenantRef to the context tenant; an explicit one wins', async () => {
    const store = new InMemoryAgentStore();
    const ctx = context();
    ctx.as('t1');
    const agent = service(store, ctx.accessor);
    await agent.recordUsage({ actorRef: 'u1', feature: 'transcription' }, { throwOnError: true });
    await agent.recordUsage(
      { actorRef: 'u1', feature: 'transcription', tenantRef: 'mine' },
      { throwOnError: true },
    );
    ctx.state.enabled = false;
    await agent.recordUsage({ actorRef: 'u1', feature: 'transcription' }, { throwOnError: true });
    expect(store.governanceUsage().map((row) => row.tenantRef)).toEqual(['t1', 'mine', undefined]);
  });
});

describe('quota per tenant', () => {
  async function ledger() {
    const store = new InMemoryAgentStore();
    const row = (actorRef: string, tenantRef: string | undefined, tokens: number) =>
      store.recordUsage({
        actorRef,
        modelId: 'm',
        purpose: 'external',
        usage: { inputTokens: tokens, outputTokens: 0 },
        ...(tenantRef !== undefined ? { tenantRef } : {}),
      });
    await row('u1', 't1', 100);
    await row('u2', 't1', 50);
    await row('u1', 't2', 7);
    await row('u1', undefined, 3);
    return store;
  }
  const dayTokens = async (provider: LedgerQuotaProvider, actor: Actor) =>
    (await provider.report({ actor })).windows.find((w) => w.period === 'day')?.usedTokens;

  it("'actor' (the default) sums the actor's rows in every tenant", async () => {
    const provider = new LedgerQuotaProvider(await ledger());
    expect(await dayTokens(provider, { id: 'u1', tenantRef: 't1' })).toBe(110);
  });

  it("'tenant' sums every actor's rows in the actor's tenant", async () => {
    const provider = new LedgerQuotaProvider(
      await ledger(),
      { day: { tokens: 120 } },
      {
        per: 'tenant',
      },
    );
    expect(await dayTokens(provider, { id: 'u1', tenantRef: 't1' })).toBe(150);
    expect((await provider.report({ actor: { id: 'u2', tenantRef: 't1' } })).blocked).toMatchObject(
      { period: 'day' },
    );
    expect(await dayTokens(provider, { id: 'u1', tenantRef: 't2' })).toBe(7);
  });

  it("'actor-in-tenant' sums the actor's own rows in that tenant", async () => {
    const provider = new LedgerQuotaProvider(await ledger(), {}, { per: 'actor-in-tenant' });
    expect(await dayTokens(provider, { id: 'u1', tenantRef: 't1' })).toBe(100);
    expect(await dayTokens(provider, { id: 'u2', tenantRef: 't1' })).toBe(50);
  });

  it('an actor without a tenant is counted per actor', async () => {
    const provider = new LedgerQuotaProvider(await ledger(), {}, { per: 'tenant' });
    expect(await dayTokens(provider, { id: 'u1' })).toBe(110);
  });

  it('refuses a store that cannot sum by tenant', () => {
    const store = new InMemoryAgentStore() as AgentStore;
    const bare = Object.create(store, { usageWindowsForTenant: { value: undefined } });
    expect(() => new LedgerQuotaProvider(bare, {}, { per: 'tenant' })).toThrow(
      /usageWindowsForTenant/,
    );
  });
});

describe('boot', () => {
  it('fails with tenancy on and a store that cannot tell a thread’s tenant', () => {
    const store = new InMemoryAgentStore();
    const bare = Object.create(store, { tenantOf: { value: undefined } }) as AgentStore;
    const ctx = context();
    expect(() => service(bare, ctx.accessor).onApplicationBootstrap()).toThrow(/tenantOf/);
    expect(() => service(bare, context(false).accessor).onApplicationBootstrap()).not.toThrow();
    expect(() => service(store, ctx.accessor).onApplicationBootstrap()).not.toThrow();
  });

  it('fails when tenancy is enabled explicitly and no context accessor answers', () => {
    const store = new InMemoryAgentStore();
    expect(() => service(store, undefined, { enabled: true }).onApplicationBootstrap()).toThrow(
      /no `@dudousxd\/nestjs-context` accessor/,
    );
    // 'inherit' with no context is simply off, and an accessor that answers boots.
    expect(() => service(store, undefined).onApplicationBootstrap()).not.toThrow();
    expect(() =>
      service(store, context().accessor, { enabled: true }).onApplicationBootstrap(),
    ).not.toThrow();
  });
});
