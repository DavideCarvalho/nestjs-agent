import {
  AGENT_DEPS_FACTORY,
  AGENT_REGISTRY,
  type AgentCatalogEntry,
  AgentRegistry,
  CanAnyone,
} from '@dudousxd/nestjs-agent-core';
import { Controller, Get, Inject, Query } from '@nestjs/common';
import type { AgentDepsFactory } from '../agent-deps.factory.js';
import { rejectUnknownParams } from '../list-api/list-api.js';

/**
 * Lists the registered `@Agent`s — and each one's personas — so a host can render an agent or
 * persona picker instead of hardcoding one.
 */
@CanAnyone()
@Controller('agents')
export class AgentsController {
  constructor(
    @Inject(AGENT_REGISTRY) private readonly agents: AgentRegistry,
    @Inject(AGENT_DEPS_FACTORY) private readonly depsFactory: AgentDepsFactory,
  ) {}

  /** `{ data }`: every registered agent, unpaged. Takes no query params. */
  @Get()
  list(@Query() query: Record<string, unknown>): { data: AgentCatalogEntry[] } {
    rejectUnknownParams(query, []);
    const defaultAgentName = this.depsFactory.defaultAgentName();
    const data = this.agents.list().map((definition) => {
      const personas = this.depsFactory.personaCatalog(definition.name);
      return {
        name: definition.name,
        description: definition.description ?? '',
        ...(definition.name === defaultAgentName ? { isDefault: true } : {}),
        ...(personas.length > 0 ? { personas } : {}),
        ...(definition.defaultPersona !== undefined
          ? { defaultPersona: definition.defaultPersona }
          : {}),
      };
    });
    return { data };
  }
}
