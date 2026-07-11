import { AgentRegistry, DefaultRolesPolicy, ToolRegistry } from '@dudousxd/nestjs-agent-core';
import {
  FakeModelProvider,
  InMemoryAgentStore,
  InMemoryTokenStreamSink,
} from '@dudousxd/nestjs-agent-testing';
import { describe, expect, it } from 'vitest';
import { AgentDepsFactory } from '../agent-deps.factory.js';
import { HeaderActorResolver } from '../resolver/header-actor-resolver.js';
import { AgentsController } from './agents.controller.js';

/** Builds a real `AgentDepsFactory` (no NestJS DI) against a caller-supplied `AgentRegistry`. */
function buildDepsFactory(agents: AgentRegistry, defaultAgent?: string): AgentDepsFactory {
  return new AgentDepsFactory(
    {
      model: new FakeModelProvider(() => ({ text: 'unused' })),
      actorResolver: new HeaderActorResolver(),
      ...(defaultAgent !== undefined ? { defaultAgent } : {}),
    },
    new FakeModelProvider(() => ({ text: 'unused' })),
    new InMemoryAgentStore(),
    new InMemoryTokenStreamSink(),
    new DefaultRolesPolicy(),
    new ToolRegistry(),
    agents,
    [],
    undefined,
    undefined,
  );
}

describe('AgentsController', () => {
  it('lists registered agents with their public name/description', () => {
    const agents = new AgentRegistry();
    agents.register({ name: 'support', description: 'Handles support tickets.' });
    agents.register({ name: 'billing', description: 'Answers billing questions.' });

    const controller = new AgentsController(agents, buildDepsFactory(agents, 'support'));

    expect(controller.list()).toEqual([
      { name: 'support', description: 'Handles support tickets.', isDefault: true },
      { name: 'billing', description: 'Answers billing questions.' },
    ]);
  });

  it('defaults an agent with no description to an empty string', () => {
    const agents = new AgentRegistry();
    agents.register({ name: 'default' });

    const controller = new AgentsController(agents, buildDepsFactory(agents));

    expect(controller.list()).toEqual([{ name: 'default', description: '', isDefault: true }]);
  });

  it('omits isDefault for every entry when the default agent is not among them', () => {
    const agents = new AgentRegistry();
    agents.register({ name: 'support', description: 'Handles support tickets.' });

    const controller = new AgentsController(agents, buildDepsFactory(agents, 'ghost'));

    expect(controller.list()).toEqual([
      { name: 'support', description: 'Handles support tickets.' },
    ]);
  });
});
