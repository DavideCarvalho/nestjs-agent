import {
  AGENT_ACTOR_RESOLVER,
  AGENT_DEPS_FACTORY,
  AGENT_REGISTRY,
  ALL_AGENTS,
  type ActorResolver,
  AgentRegistry,
  type ToolCatalogEntry,
} from '@dudousxd/nestjs-agent-core';
import { Controller, Get, Inject, NotFoundException, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { AgentDepsFactory } from '../agent-deps.factory.js';

/**
 * The tools THIS caller can reach through an agent, with how a chat surface should talk about each
 * one (`@AiTool({ presentation })`) — so a client narrates "Querying orders" instead of printing
 * `executeSql`, from words declared beside the tool's input schema rather than a client-side map
 * that goes stale on the next rename.
 *
 * THE SAME LIST THE MODEL IS OFFERED: built by `ToolRegistry.visibleSpecs`, the call behind
 * `definitionsFor`, against the agent's own allow-list, the roles policy and each tool's
 * `isEnabled`/`canUse`. Built-in tools the loop serves itself (`ask`, `skill`, `remember`) are not
 * registry tools and are not listed.
 *
 * Posture mirrors `GET /agent/skills`: a plain array, and nothing the caller can pass to widen it —
 * the actor comes from the resolver, and `agent` only ever narrows to that agent's allow-list.
 */
@Controller('tools')
export class ToolsController {
  constructor(
    @Inject(AGENT_ACTOR_RESOLVER) private readonly actorResolver: ActorResolver,
    @Inject(AGENT_DEPS_FACTORY) private readonly depsFactory: AgentDepsFactory,
    @Inject(AGENT_REGISTRY) private readonly agents: AgentRegistry,
  ) {}

  @Get()
  async list(
    @Req() req: Request,
    /**
     * The agent whose tools to list. Omitted → the default agent, the one a turn naming none uses.
     * `*` → every agent's: the union of what this actor reaches through any of them, each tool once
     * — for a surface that shows several agents' conversations.
     */
    @Query('agent') agent?: string,
  ): Promise<ToolCatalogEntry[]> {
    // An unknown name would otherwise resolve to NO allow-list — every tool — which is the widest
    // answer this endpoint can give, for a typo.
    if (agent !== undefined && agent !== ALL_AGENTS && this.agents.get(agent) === undefined) {
      throw new NotFoundException(`No agent named "${agent}"`);
    }
    const actor = await this.actorResolver.resolve(req);
    const names =
      agent === ALL_AGENTS
        ? [undefined, ...this.agents.list().map((definition) => definition.name)]
        : [agent];
    const entries = new Map<string, ToolCatalogEntry>();
    for (const name of names) {
      const deps = this.depsFactory.forAgent(name);
      const specs = await deps.registry.visibleSpecs(actor, deps.rolesPolicy, deps.toolAllowList);
      for (const spec of specs) {
        if (entries.has(spec.name)) continue;
        entries.set(spec.name, {
          name: spec.name,
          kind: spec.kind,
          ...(spec.presentation !== undefined ? { presentation: spec.presentation } : {}),
        });
      }
    }
    return [...entries.values()];
  }
}
