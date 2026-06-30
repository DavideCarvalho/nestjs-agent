import { Controller, Get, Req } from '@nestjs/common';
import type { Request } from 'express';
import { AgentService } from '../agent.service.js';
import { resolveActor } from '../util/actor.js';

@Controller('agent/quota')
export class QuotaController {
  constructor(private readonly agent: AgentService) {}

  @Get('today')
  today(@Req() req: Request) {
    return this.agent.quotaToday(resolveActor(req).id);
  }
}
