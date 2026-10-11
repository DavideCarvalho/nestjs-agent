import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  PERSONAL_AGENT_ROLE,
  missingScopes,
  personalAgentGate,
  personalAgentScopes,
  scopeRole,
} from './personal-agent.js';
import { filterToolsByRole } from './tool-filters.js';
import { DefaultRolesPolicy, ToolRegistry } from './tool-registry.js';
import type { ToolSpec } from './types.js';

const tool = (name: string, roles?: string[]): ToolSpec => ({
  name,
  kind: 'read',
  description: name,
  inputSchema: z.object({}),
  ...(roles !== undefined ? { roles } : {}),
});

const open = tool('open');
const general = tool('store_hours', [PERSONAL_AGENT_ROLE]);
const reads = tool('list_orders', [scopeRole('poppy:read')]);
const writes = tool('cancel_order', [scopeRole('poppy:write')]);
const signedIn = { id: 'acct-1', roles: [PERSONAL_AGENT_ROLE, scopeRole('poppy:read')] };
const person = { id: 'u1', roles: ['member'] };

describe('personalAgentGate', () => {
  const gate = personalAgentGate(new DefaultRolesPolicy([]));

  it('runs for a personal agent only the tools that declare one of its roles', async () => {
    expect(await gate.can(signedIn, open)).toBe(false);
    expect(await gate.can(signedIn, general)).toBe(true);
    expect(await gate.can(signedIn, reads)).toBe(true);
    expect(await gate.can(signedIn, writes)).toBe(false);
  });

  it('offers it every tool written for personal agents, granted or not', async () => {
    expect(await gate.canOffer?.(signedIn, writes)).toBe(true);
    expect(await gate.canOffer?.(signedIn, open)).toBe(false);
    const offered = await filterToolsByRole([open, general, reads, writes], signedIn, gate);
    expect(offered.map((spec) => spec.name)).toEqual([
      'store_hours',
      'list_orders',
      'cancel_order',
    ]);
  });

  it('leaves every other actor to the wrapped policy', async () => {
    expect(await gate.can(person, open)).toBe(true);
    expect(await gate.canOffer?.(person, open)).toBe(true);
  });

  it('wrapping twice is a no-op', () => {
    expect(personalAgentGate(gate)).toBe(gate);
  });

  it('names the scopes a personal agent lacks to run an offered tool', async () => {
    expect(await missingScopes(signedIn, writes, gate)).toEqual(['poppy:write']);
    expect(await missingScopes(signedIn, reads, gate)).toBeNull();
    expect(await missingScopes(signedIn, open, gate)).toBeNull();
    expect(await missingScopes(person, writes, gate)).toBeNull();
  });

  it('offers through the registry but refuses the call', async () => {
    const registry = new ToolRegistry();
    registry.register(writes, { execute: async () => 'cancelled' });
    const offered = await registry.definitionsFor(signedIn, gate);
    expect(offered.map((d) => d.name)).toEqual(['cancel_order']);
    await expect(
      registry.invoke('cancel_order', {}, { actor: signedIn, threadId: 't', requestId: 'r' }, gate),
    ).rejects.toThrow();
  });
});

describe('personalAgentScopes', () => {
  it('resolves no scope for a personal agent, the inner resolver for anyone else', async () => {
    const scopes = personalAgentScopes({ resolve: () => ['actor:x'] });
    expect(await scopes.resolve({ actor: signedIn, threadId: 't' })).toEqual([]);
    expect(await scopes.resolve({ actor: person, threadId: 't' })).toEqual(['actor:x']);
  });
});
