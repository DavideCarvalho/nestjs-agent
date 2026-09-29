import {
  AGENT_ACTOR_RESOLVER,
  type ActorResolver,
  type ModelCatalogView,
} from '@dudousxd/nestjs-agent-core';
import { Controller, Get, Inject, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { AgentService } from '../agent.service.js';

@Controller('models')
export class ModelsController {
  constructor(
    private readonly agent: AgentService,
    @Inject(AGENT_ACTOR_RESOLVER) private readonly actorResolver: ActorResolver,
  ) {}

  /**
   * The models the caller may pick for `agent` (the default agent when omitted), grouped by
   * provider, with badges and availability — the bound `ModelCatalog`'s answer, or an empty one.
   */
  @Get()
  async list(@Req() req: Request, @Query('agent') agent?: string): Promise<ModelCatalogView> {
    const actor = await this.actorResolver.resolve(req);
    return this.agent.listModels(actor, agent);
  }
}
