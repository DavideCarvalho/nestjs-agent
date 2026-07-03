import type { Actor, ToolSpec } from '@dudousxd/nestjs-agent-core';
import { Gate, PolicyRegistry } from '@dudousxd/nestjs-authz';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AuthzRolesPolicy } from './authz-roles-policy.js';

/**
 * A real authz {@link Gate} with one ad-hoc gate registered via `define`. The gate
 * reads `user.roles` — exactly the shape `userFromActor` produces — so a role-based
 * ability resolves without any policy classes or RBAC tables.
 */
function buildGate(): Gate {
  const gate = new Gate(new PolicyRegistry(), undefined);
  gate.define('cache.purge', (user) => (user as { roles?: string[] }).roles?.includes('ADMIN') ?? false);
  return gate;
}

const admin: Actor = { id: 'u1', roles: ['ADMIN'] };
const guest: Actor = { id: 'u2', roles: ['GUEST'] };

function tool(overrides: Partial<ToolSpec>): ToolSpec {
  return {
    name: 'purge',
    kind: 'action',
    description: 'Purge the cache',
    inputSchema: z.object({}),
    ...overrides,
  };
}

describe('AuthzRolesPolicy', () => {
  it('delegates an ability tool to the Gate — allowed for ADMIN, denied for GUEST', async () => {
    const policy = new AuthzRolesPolicy(buildGate());
    const abilityTool = tool({ ability: 'cache.purge' });

    expect(await policy.can(admin, abilityTool)).toBe(true);
    expect(await policy.can(guest, abilityTool)).toBe(false);
  });

  it('falls back to role matching when a tool declares no ability', async () => {
    const policy = new AuthzRolesPolicy(buildGate());
    const roleTool = tool({ roles: ['ADMIN'] });

    expect(await policy.can(admin, roleTool)).toBe(true);
    expect(await policy.can(guest, roleTool)).toBe(false);
  });

  it('uses the default fallback (ADMIN-only) when a tool declares neither ability nor roles', async () => {
    const policy = new AuthzRolesPolicy(buildGate());
    const bareTool = tool({});

    expect(await policy.can(admin, bareTool)).toBe(true);
    expect(await policy.can(guest, bareTool)).toBe(false);
  });

  it('honors configured fallbackRoles for tools with neither ability nor roles', async () => {
    const policy = new AuthzRolesPolicy(buildGate(), { fallbackRoles: ['GUEST'] });
    const bareTool = tool({});

    expect(await policy.can(guest, bareTool)).toBe(true);
    expect(await policy.can(admin, bareTool)).toBe(false);
  });
});
