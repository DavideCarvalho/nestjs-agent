import {
  AGENT_DEPS_FACTORY,
  AGENT_REGISTRY,
  type AgentCatalogEntry,
  AgentRegistry,
} from '@dudousxd/nestjs-agent-core';
import { Controller, Get, Inject } from '@nestjs/common';
import type { AgentDepsFactory } from '../agent-deps.factory.js';

/** Lists the registered `@Agent`s so a host can render a persona picker instead of hardcoding one. */
@Controller('agents')
export class AgentsController {
  constructor(
    @Inject(AGENT_REGISTRY) private readonly agents: AgentRegistry,
    @Inject(AGENT_DEPS_FACTORY) private readonly depsFactory: AgentDepsFactory,
  ) {}

  @Get()
  list(): AgentCatalogEntry[] {
    const defaultAgentName = this.depsFactory.defaultAgentName();
    return this.agents.list().map((definition) => ({
      name: definition.name,
      description: definition.description ?? '',
      ...(definition.name === defaultAgentName ? { isDefault: true } : {}),
    }));
  }
}
