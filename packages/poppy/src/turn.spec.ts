import { AGENT_TOOL_REGISTRY, AgentModule, AgentService, AiTool } from '@dudousxd/nestjs-agent';
import {
  type Actor,
  InMemoryAgentStore,
  PERSONAL_AGENT_ROLE,
  type ToolRegistry,
  scopeRole,
} from '@dudousxd/nestjs-agent-core';
import { FakeModelProvider, type FakeScript } from '@dudousxd/nestjs-agent-testing';
import { type INestApplication, Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runPersonalAgentTurn } from './turn.js';

const ran: string[] = [];

@AiTool({
  name: 'cancel_order',
  kind: 'action',
  description: 'Cancel an order',
  input: z.object({ id: z.string() }),
  roles: [scopeRole('poppy:write')],
})
@Injectable()
class CancelOrderTool {
  async execute({ id }: { id: string }) {
    ran.push(`cancel_order:${id}`);
    return { cancelled: id };
  }
}

let app: INestApplication | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
  ran.length = 0;
});

/** A model that calls `cancel_order` once, then answers — and streams NO tool frames itself. */
const script: FakeScript = (_args, turnIndex) =>
  turnIndex === 0
    ? { text: '', toolCall: { name: 'cancel_order', input: { id: 'A-1' } } }
    : { text: 'Done.' };

async function boot() {
  const module = await Test.createTestingModule({
    imports: [
      AgentModule.forRoot({
        model: new FakeModelProvider(script),
        store: new InMemoryAgentStore(),
        actorResolver: { resolve: () => ({ id: 'nobody' }) },
      }),
    ],
    providers: [CancelOrderTool],
  }).compile();
  app = module.createNestApplication({ logger: false });
  await app.init();
  const registry = app.get<ToolRegistry>(AGENT_TOOL_REGISTRY);
  return {
    service: app.get(AgentService),
    toolRoles: (name: string) => registry.spec(name)?.roles,
  };
}

const personalAgent = (scopes: string[]): Actor => ({
  id: 'acct-1',
  roles: [PERSONAL_AGENT_ROLE, ...scopes.map(scopeRole)],
});

describe('runPersonalAgentTurn over a provider that streams no tool frames', () => {
  it('attributes a refused call to the scope it lacked (the loop announced the call)', async () => {
    const { service, toolRoles } = await boot();
    const result = await runPersonalAgentTurn(service, toolRoles, {
      actor: personalAgent(['poppy:read']),
      text: 'cancel A-1',
      delegatedScopes: ['poppy:read'],
      actions: 'approve-delegated',
      timeoutMs: 10_000,
    });
    expect(result.permission).toEqual(['poppy:write']);
    expect(ran).toEqual([]);
  });

  it('approves an action by the granted scope and reports it as done', async () => {
    const { service, toolRoles } = await boot();
    const result = await runPersonalAgentTurn(service, toolRoles, {
      actor: personalAgent(['poppy:write']),
      text: 'cancel A-1',
      delegatedScopes: ['poppy:write'],
      actions: 'approve-delegated',
      timeoutMs: 10_000,
    });
    expect(result.error).toBeNull();
    expect(ran).toEqual(['cancel_order:A-1']);
    expect(result.actions).toMatchObject([{ tool: 'cancel_order', scopes: ['poppy:write'] }]);
  });
});
