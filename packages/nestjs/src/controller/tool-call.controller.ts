import { AGENT_ACTOR_RESOLVER, type ActorResolver } from '@dudousxd/nestjs-agent-core';
import { Body, Controller, Inject, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { AgentService } from '../agent.service.js';

interface ApproveBody {
  toolCallId: string;
}
interface RejectBody extends ApproveBody {
  reason?: string;
}

@Controller('tool-call')
export class ToolCallController {
  constructor(
    private readonly agent: AgentService,
    @Inject(AGENT_ACTOR_RESOLVER) private readonly actorResolver: ActorResolver,
  ) {}

  @Post('approve')
  async approve(@Req() req: Request, @Body() body: ApproveBody): Promise<{ ok: boolean }> {
    const actor = await this.actorResolver.resolve(req);
    await this.agent.approve(actor, body.toolCallId);
    return { ok: true };
  }

  @Post('reject')
  async reject(@Req() req: Request, @Body() body: RejectBody): Promise<{ ok: boolean }> {
    const actor = await this.actorResolver.resolve(req);
    await this.agent.reject(actor, body.toolCallId, body.reason);
    return { ok: true };
  }
}
