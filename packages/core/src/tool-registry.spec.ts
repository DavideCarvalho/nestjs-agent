import type { StandardSchemaV1 } from '@standard-schema/spec';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  type Actor,
  type AiToolCtx,
  DefaultRolesPolicy,
  filterToolsByAllowList,
  ToolForbiddenError,
  ToolInputInvalidError,
  ToolRegistry,
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

describe('filterToolsByAllowList', () => {
  const specs = registry().allSpecs();

  it('returns every tool unchanged when no allow-list is given', () => {
    expect(filterToolsByAllowList(specs, undefined).map((spec) => spec.name).sort()).toEqual([
      'getWeather',
      'purgeCache',
    ]);
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
