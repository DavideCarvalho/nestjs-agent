import {
  AGENT_ACTOR_RESOLVER,
  type ActorResolver,
  CanAnyone,
  type ModelCatalogProviderGroup,
  type ModelCatalogView,
} from '@dudousxd/nestjs-agent-core';
import { Controller, Get, Inject, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { AgentService } from '../agent.service.js';
import { parseFilterParams, rejectUnknownParams } from '../list-api/list-api.js';

/**
 * `GET <base>/models`: the provider groups as `data`, with the catalog-wide `default` (and `locked`,
 * when the agent is pinned to one model) beside it.
 */
export interface ModelCatalogListResponse extends Omit<ModelCatalogView, 'providers'> {
  data: ModelCatalogProviderGroup[];
}

@CanAnyone()
@Controller('models')
export class ModelsController {
  constructor(
    private readonly agent: AgentService,
    @Inject(AGENT_ACTOR_RESOLVER) private readonly actorResolver: ActorResolver,
  ) {}

  /**
   * The models the caller may pick for `filter[agent]` (the default agent when omitted), grouped by
   * provider in `data`, with badges and availability — the bound `ModelCatalog`'s answer, or an
   * empty one. `default` is the model a turn of that agent under `filter[persona]` (else its default
   * persona) runs on.
   */
  @Get()
  async list(
    @Req() req: Request,
    @Query() query: Record<string, unknown>,
  ): Promise<ModelCatalogListResponse> {
    rejectUnknownParams(query, ['filter']);
    let agent: string | undefined;
    let persona: string | undefined;
    for (const condition of parseFilterParams(query, {
      fields: { agent: ['eq'], persona: ['eq'] },
    })) {
      if (condition.field === 'agent') agent = condition.value as string;
      else persona = condition.value as string;
    }
    const actor = await this.actorResolver.resolve(req);
    const { providers, ...rest } = await this.agent.listModels(actor, agent, persona);
    return { data: providers, ...rest };
  }
}
