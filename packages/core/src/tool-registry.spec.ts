import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  DefaultRolesPolicy,
  ToolForbiddenError,
  ToolRegistry,
  type Actor,
  type AiToolCtx,
} from './index.js';

function ctxFor(actor: Actor): AiToolCtx {
  return {
    actorId: actor.id,
    threadId: 't1',
    runId: 'r1',
    requestId: 'r1',
    actor,
  };
}

describe('ToolRegistry', () => {
  const policy = new DefaultRolesPolicy();

  function registry(): ToolRegistry {
    const reg = new ToolRegistry();
    reg.register(
      { name: 'getWeather', kind: 'read', description: 'weather', inputSchema: z.object({ city: z.string() }) },
      { execute: async (input: { city: string }) => ({ tempC: 21, city: input.city }) },
    );
    reg.register(
      { name: 'purgeCache', kind: 'action', description: 'purge', inputSchema: z.object({ key: z.string() }) },
      { execute: async () => ({ purged: true }) },
    );
    return reg;
  }

  it('offers neutral definitions for an allowed actor (no execute leaks)', async () => {
    const defs = await registry().definitionsFor({ id: 'u1', roles: ['ADMIN'] }, policy);
    expect(defs.map((d) => d.name).sort()).toEqual(['getWeather', 'purgeCache']);
    expect(defs.every((d) => !('execute' in d))).toBe(true);
  });

  it('filters out tools the role may not use', async () => {
    const defs = await registry().definitionsFor({ id: 'u2', roles: ['GUEST'] }, policy);
    expect(defs).toHaveLength(0);
  });

  it('applies the persona allow-list on top of role filtering', async () => {
    const defs = await registry().definitionsFor({ id: 'u1', roles: ['ADMIN'] }, policy, ['getWeather']);
    expect(defs.map((d) => d.name)).toEqual(['getWeather']);
  });

  it('invokes a read tool, re-parsing input via Zod', async () => {
    const out = await registry().invoke('getWeather', { city: 'Recife' }, ctxFor({ id: 'u1', roles: ['ADMIN'] }), policy);
    expect(out).toEqual({ tempC: 21, city: 'Recife' });
  });

  it('rejects invocation by a disallowed role (defense in depth)', async () => {
    await expect(
      registry().invoke('getWeather', { city: 'Recife' }, ctxFor({ id: 'u2', roles: ['GUEST'] }), policy),
    ).rejects.toBeInstanceOf(ToolForbiddenError);
  });

  it('throws on invalid input', async () => {
    await expect(
      registry().invoke('getWeather', { city: 123 }, ctxFor({ id: 'u1', roles: ['ADMIN'] }), policy),
    ).rejects.toThrow();
  });
});
