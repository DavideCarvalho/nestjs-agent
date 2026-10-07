import 'reflect-metadata';
import { AgentDepsFactory, AgentModule } from '@dudousxd/nestjs-agent';
import { AGENT_ROLES_POLICY, type RolesPolicy, type ToolSpec } from '@dudousxd/nestjs-agent-core';
import { FakeModelProvider, InMemoryAgentStore } from '@dudousxd/nestjs-agent-testing';
import { AuthzModule, Gate } from '@dudousxd/nestjs-authz';
import { type DynamicModule, Module, type OnModuleInit } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AgentAuthzModule } from './agent-authz.module.js';

const purge: ToolSpec = {
  name: 'purgeCache',
  kind: 'action',
  description: 'Purge the cache',
  inputSchema: z.object({}),
  ability: 'cache.purge',
};
const admin = { id: 'u1', roles: ['ADMIN'] };
const guest = { id: 'u2', roles: ['GUEST'] };

/** Defines the one ad-hoc ability the spec checks, on the app's global Gate. */
@Module({})
class AbilitiesModule implements OnModuleInit {
  constructor(private readonly gate: Gate) {}
  onModuleInit(): void {
    this.gate.define(
      'cache.purge',
      (user) => (user as { roles?: string[] }).roles?.includes('ADMIN') ?? false,
    );
  }
}

/** The policy the agent loop actually consults: the one `AgentDepsFactory` was built with. */
async function agentPolicy(imports: DynamicModule[]): Promise<RolesPolicy> {
  const moduleRef = await Test.createTestingModule({
    imports: [AuthzModule.forRoot(), AbilitiesModule, ...imports],
  }).compile();
  await moduleRef.init();
  const factory = moduleRef.get(AgentDepsFactory);
  const policy = (factory as unknown as { rolesPolicy: RolesPolicy }).rolesPolicy;
  // Read through the module's own token too: the MCP server and any host code inject it there.
  const exported = moduleRef.get<RolesPolicy>(AGENT_ROLES_POLICY, { strict: false });
  expect(await exported.can(guest, purge)).toBe(await policy.can(guest, purge));
  await moduleRef.close();
  return policy;
}

const agent = (): DynamicModule =>
  AgentModule.forRoot({
    model: new FakeModelProvider(() => ({ text: 'ok' })),
    store: new InMemoryAgentStore(),
  });

describe('AgentAuthzModule — wired the documented way', () => {
  it('reaches the agent loop: an ability tool is decided by the Gate', async () => {
    const policy = await agentPolicy([agent(), AgentAuthzModule.forRoot()]);
    expect(await policy.can(admin, purge)).toBe(true);
    expect(await policy.can(guest, purge)).toBe(false);
  });

  it('reaches it whatever the import order', async () => {
    const policy = await agentPolicy([AgentAuthzModule.forRoot(), agent()]);
    expect(await policy.can(admin, purge)).toBe(true);
    expect(await policy.can(guest, purge)).toBe(false);
  });

  it('fails closed without it: an ability tool reaches nobody, not everybody', async () => {
    const policy = await agentPolicy([agent()]);
    expect(await policy.can(admin, purge)).toBe(false);
    expect(await policy.can(guest, purge)).toBe(false);
  });
});
