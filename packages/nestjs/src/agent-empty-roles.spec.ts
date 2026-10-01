import { AGENT_ROLES_POLICY, type RolesPolicy, type ToolSpec } from '@dudousxd/nestjs-agent-core';
import { FakeModelProvider, InMemoryAgentStore } from '@dudousxd/nestjs-agent-testing';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AgentModule } from './agent.module.js';
import type { AgentModuleOptions } from './agent.options.js';

const bare: ToolSpec = { name: 'ping', kind: 'read', description: 'p', inputSchema: z.object({}) };
const staff = { id: 'u1', roles: ['STAFF'] };

async function policyFor(options: Partial<AgentModuleOptions>): Promise<RolesPolicy> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      AgentModule.forRoot({
        model: new FakeModelProvider(() => ({ text: 'ok' })),
        store: new InMemoryAgentStore(),
        ...options,
      }),
    ],
  }).compile();
  const policy = moduleRef.get<RolesPolicy>(AGENT_ROLES_POLICY);
  await moduleRef.close();
  return policy;
}

describe('AgentModule — what an empty roles list means', () => {
  it('is open by default: a tool that names no roles reaches every resolved actor', async () => {
    const policy = await policyFor({});
    expect(await policy.can(staff, bare)).toBe(true);
    expect(await policy.can({ id: 'anon' }, bare)).toBe(true);
  });

  it("stays closed under emptyRoles: 'deny' — the tool needs roles, or default roles", async () => {
    const closed = await policyFor({ emptyRoles: 'deny' });
    expect(await closed.can(staff, bare)).toBe(false);
    expect(await closed.can(staff, { ...bare, roles: [] })).toBe(false);
    expect(await closed.can(staff, { ...bare, roles: ['STAFF'] })).toBe(true);
    const withDefaults = await policyFor({ emptyRoles: 'deny', defaultRoles: ['STAFF'] });
    expect(await withDefaults.can(staff, bare)).toBe(true);
  });

  it('leaves a rolesPolicy of your own alone', async () => {
    const own: RolesPolicy = { can: () => true };
    expect(await policyFor({ emptyRoles: 'deny', rolesPolicy: own })).toBe(own);
  });
});
