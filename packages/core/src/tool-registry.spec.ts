import type { StandardSchemaV1 } from '@standard-schema/spec';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  type Actor,
  type AiToolCtx,
  DefaultRolesPolicy,
  ToolDisabledError,
  ToolForbiddenError,
  type ToolHandler,
  ToolInputInvalidError,
  ToolNotFoundError,
  ToolRegistry,
  type ToolSpec,
  filterToolsByAllowList,
} from './index.js';

/** A hand-rolled Standard Schema (no Zod) — proves the registry is validation-library-agnostic. */
const upperCityValibotLike: StandardSchemaV1<{ city: string }, { city: string }> = {
  '~standard': {
    version: 1,
    vendor: 'handmade',
    validate(value) {
      if (
        typeof value === 'object' &&
        value !== null &&
        typeof (value as { city?: unknown }).city === 'string'
      ) {
        return { value: { city: (value as { city: string }).city.toUpperCase() } };
      }
      return { issues: [{ message: 'city must be a string' }] };
    },
  },
};

function ctxFor(actor: Actor): AiToolCtx {
  return {
    actor,
    threadId: 't1',
    runId: 'r1',
    requestId: 'r1',
  };
}

function registry(): ToolRegistry {
  const reg = new ToolRegistry();
  reg.register(
    {
      name: 'getWeather',
      kind: 'read',
      description: 'weather',
      inputSchema: z.object({ city: z.string() }),
    },
    { execute: async (input: { city: string }) => ({ tempC: 21, city: input.city }) },
  );
  reg.register(
    {
      name: 'purgeCache',
      kind: 'action',
      description: 'purge',
      inputSchema: z.object({ key: z.string() }),
    },
    { execute: async () => ({ purged: true }) },
  );
  return reg;
}

describe('ToolRegistry', () => {
  const policy = new DefaultRolesPolicy();

  it('offers neutral definitions for an allowed actor (no execute leaks)', async () => {
    const defs = await registry().definitionsFor({ id: 'u1', roles: ['ADMIN'] }, policy);
    expect(defs.map((d) => d.name).sort()).toEqual(['getWeather', 'purgeCache']);
    expect(defs.every((d) => !('execute' in d))).toBe(true);
  });

  it('filters out tools the role may not use', async () => {
    const defs = await registry().definitionsFor({ id: 'u2', roles: ['GUEST'] }, policy);
    expect(defs).toHaveLength(0);
  });

  it('applies the agent tool allow-list on top of role filtering', async () => {
    const defs = await registry().definitionsFor({ id: 'u1', roles: ['ADMIN'] }, policy, [
      'getWeather',
    ]);
    expect(defs.map((d) => d.name)).toEqual(['getWeather']);
  });

  it('invokes a read tool, re-parsing input via Zod', async () => {
    const out = await registry().invoke(
      'getWeather',
      { city: 'Recife' },
      ctxFor({ id: 'u1', roles: ['ADMIN'] }),
      policy,
    );
    expect(out).toEqual({ tempC: 21, city: 'Recife' });
  });

  it('rejects invocation by a disallowed role (defense in depth)', async () => {
    await expect(
      registry().invoke(
        'getWeather',
        { city: 'Recife' },
        ctxFor({ id: 'u2', roles: ['GUEST'] }),
        policy,
      ),
    ).rejects.toBeInstanceOf(ToolForbiddenError);
  });

  it('throws ToolInputInvalidError (with issues) on invalid input', async () => {
    await expect(
      registry().invoke(
        'getWeather',
        { city: 123 },
        ctxFor({ id: 'u1', roles: ['ADMIN'] }),
        policy,
      ),
    ).rejects.toBeInstanceOf(ToolInputInvalidError);
  });

  it('validates via any Standard Schema (not just Zod) and passes the parsed value', async () => {
    const reg = new ToolRegistry();
    reg.register(
      { name: 'echoCity', kind: 'read', description: 'echo', inputSchema: upperCityValibotLike },
      { execute: async (input: { city: string }) => input },
    );
    const out = await reg.invoke(
      'echoCity',
      { city: 'recife' },
      ctxFor({ id: 'u1', roles: ['ADMIN'] }),
      policy,
    );
    // the schema uppercased the input, proving `~standard.validate`'s value (not the raw input) is used
    expect(out).toEqual({ city: 'RECIFE' });

    await expect(
      reg.invoke('echoCity', { city: 42 }, ctxFor({ id: 'u1', roles: ['ADMIN'] }), policy),
    ).rejects.toBeInstanceOf(ToolInputInvalidError);
  });
});

describe('ToolRegistry — disabled tools', () => {
  const policy = new DefaultRolesPolicy();
  const admin: Actor = { id: 'u1', roles: ['ADMIN'] };

  function withEnabled(
    enabled: ToolSpec['enabled'],
    handler: ToolHandler = { execute: async () => ({ ok: true }) },
  ): ToolRegistry {
    const reg = new ToolRegistry();
    reg.register(
      {
        name: 'searchDocs',
        kind: 'read',
        description: 'search',
        inputSchema: z.object({ q: z.string() }),
        ...(enabled !== undefined ? { enabled } : {}),
      },
      handler,
    );
    return reg;
  }

  it('does not offer a tool disabled by its spec', async () => {
    expect(await withEnabled(false).definitionsFor(admin, policy)).toEqual([]);
  });

  it('offers a tool whose spec says nothing about being enabled', async () => {
    const defs = await withEnabled(undefined).definitionsFor(admin, policy);
    expect(defs.map((d) => d.name)).toEqual(['searchDocs']);
  });

  it('re-reads a predicate every turn, so flipping the flag needs no re-registration', async () => {
    let on = false;
    const reg = withEnabled(() => on);
    expect(await reg.definitionsFor(admin, policy)).toEqual([]);
    on = true;
    expect((await reg.definitionsFor(admin, policy)).map((d) => d.name)).toEqual(['searchDocs']);
  });

  it("honours the handler's isEnabled() — the seam for a flag that lives in an injected service", async () => {
    const reg = withEnabled(undefined, {
      execute: async () => ({ ok: true }),
      isEnabled: () => false,
    });
    expect(await reg.definitionsFor(admin, policy)).toEqual([]);
  });

  it('needs BOTH the spec and the handler to agree before offering the tool', async () => {
    const reg = withEnabled(true, {
      execute: async () => ({ ok: true }),
      isEnabled: async () => false,
    });
    expect(await reg.definitionsFor(admin, policy)).toEqual([]);
  });

  it('refuses to invoke a disabled tool — an approval granted before the flag moved must not run it', async () => {
    await expect(
      withEnabled(false).invoke('searchDocs', { q: 'x' }, ctxFor(admin), policy),
    ).rejects.toBeInstanceOf(ToolDisabledError);
  });

  it('reports a disabled tool as disabled, not as unregistered or forbidden', async () => {
    // The three failures are operationally different: flip the flag / add the role / fix the name.
    await expect(
      withEnabled(false).invoke('searchDocs', { q: 'x' }, ctxFor(admin), policy),
    ).rejects.not.toBeInstanceOf(ToolNotFoundError);
    await expect(
      withEnabled(false).invoke('searchDocs', { q: 'x' }, ctxFor(admin), policy),
    ).rejects.not.toBeInstanceOf(ToolForbiddenError);
  });

  it('checks enabled BEFORE the role, so a disabled tool never leaks its existence via a role error', async () => {
    await expect(
      withEnabled(false).invoke(
        'searchDocs',
        { q: 'x' },
        ctxFor({ id: 'u2', roles: ['GUEST'] }),
        policy,
      ),
    ).rejects.toBeInstanceOf(ToolDisabledError);
  });
});

describe('ToolRegistry — a tool that gates its own actors', () => {
  const policy = new DefaultRolesPolicy();
  const admin: Actor = { id: 'u1', roles: ['ADMIN'] };
  const otherAdmin: Actor = { id: 'u2', roles: ['ADMIN'] };

  function withCanUse(canUse: NonNullable<ToolHandler['canUse']>): ToolRegistry {
    const reg = new ToolRegistry();
    reg.register(
      {
        name: 'searchDocs',
        kind: 'read',
        description: 'search',
        inputSchema: z.object({ q: z.string() }),
      },
      { execute: async () => ({ ok: true }), canUse },
    );
    return reg;
  }

  const onlyU1: NonNullable<ToolHandler['canUse']> = (actor) => actor.id === 'u1';

  it('offers the tool to the actor it allows', async () => {
    const defs = await withCanUse(onlyU1).definitionsFor(admin, policy);
    expect(defs.map((d) => d.name)).toEqual(['searchDocs']);
  });

  it('hides it from an actor it refuses, even though the ROLE would allow it', async () => {
    // The role gate passes for both — this is the per-user layer the role gate can't express.
    expect(await withCanUse(onlyU1).definitionsFor(otherAdmin, policy)).toEqual([]);
  });

  it('re-decides per turn, so an entitlement granted mid-thread appears without a restart', async () => {
    const entitled = new Set<string>();
    const reg = withCanUse((actor) => entitled.has(actor.id));
    expect(await reg.definitionsFor(admin, policy)).toEqual([]);
    entitled.add('u1');
    expect((await reg.definitionsFor(admin, policy)).map((d) => d.name)).toEqual(['searchDocs']);
  });

  it('rejects invocation by a refused actor (defense in depth)', async () => {
    await expect(
      withCanUse(onlyU1).invoke('searchDocs', { q: 'x' }, ctxFor(otherAdmin), policy),
    ).rejects.toBeInstanceOf(ToolForbiddenError);
  });

  it('supports an async decision (a DB or entitlement lookup)', async () => {
    const reg = withCanUse(async (actor) => Promise.resolve(actor.tenantRef === 'base-1'));
    expect(await reg.definitionsFor({ ...admin, tenantRef: 'base-2' }, policy)).toEqual([]);
    expect(
      (await reg.definitionsFor({ ...admin, tenantRef: 'base-1' }, policy)).map((d) => d.name),
    ).toEqual(['searchDocs']);
  });

  it('cannot widen: a `canUse` that says yes does not survive a role gate that says no', async () => {
    await expect(
      withCanUse(() => true).invoke(
        'searchDocs',
        { q: 'x' },
        ctxFor({ id: 'u3', roles: ['GUEST'] }),
        policy,
      ),
    ).rejects.toBeInstanceOf(ToolForbiddenError);
    expect(
      await withCanUse(() => true).definitionsFor({ id: 'u3', roles: ['GUEST'] }, policy),
    ).toEqual([]);
  });
});

describe('filterToolsByAllowList', () => {
  const specs = registry().allSpecs();

  it('returns every tool unchanged when no allow-list is given', () => {
    expect(
      filterToolsByAllowList(specs, undefined)
        .map((spec) => spec.name)
        .sort(),
    ).toEqual(['getWeather', 'purgeCache']);
  });

  it('keeps only the named tools, in registry order, dropping unknown names', () => {
    expect(
      filterToolsByAllowList(specs, ['purgeCache', 'notRegistered']).map((spec) => spec.name),
    ).toEqual(['purgeCache']);
  });

  it('returns no tools for an empty allow-list', () => {
    expect(filterToolsByAllowList(specs, [])).toEqual([]);
  });
});
