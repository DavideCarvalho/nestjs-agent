import { AGENT_ACTOR_RESOLVER, type ActorResolver } from '@dudousxd/nestjs-agent-core';
import { Controller, Get, Inject, Req } from '@nestjs/common';
import type { Request } from 'express';
import { AgentService } from '../agent.service.js';

@Controller('quota')
export class QuotaController {
  constructor(
    private readonly agent: AgentService,
    @Inject(AGENT_ACTOR_RESOLVER) private readonly actorResolver: ActorResolver,
  ) {}

  /**
   * The caller's budget across windows — `{ windows: [{ period, usedTokens, limitTokens?, usedUsd,
   * limitUsd?, resetsAt? }], blocked?: { period, reason? } }` — from the bound `QuotaProvider`.
   */
  @Get()
  async report(@Req() req: Request) {
    const actor = await this.actorResolver.resolve(req);
    return this.agent.quotaReport(actor);
  }
}
