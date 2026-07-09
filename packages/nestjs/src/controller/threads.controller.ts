import { AGENT_ACTOR_RESOLVER, type ActorResolver } from '@dudousxd/nestjs-agent-core';
import { Controller, Delete, Get, Inject, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { AgentService } from '../agent.service.js';

@Controller('threads')
export class ThreadsController {
  constructor(
    private readonly agent: AgentService,
    @Inject(AGENT_ACTOR_RESOLVER) private readonly actorResolver: ActorResolver,
  ) {}

  @Get()
  async list(@Req() req: Request) {
    const actor = await this.actorResolver.resolve(req);
    return this.agent.listThreads(actor.id);
  }

  @Get(':id')
  async detail(@Req() req: Request, @Param('id') id: string) {
    const actor = await this.actorResolver.resolve(req);
    return this.agent.getThread(actor, id);
  }

  @Delete(':id')
  async remove(@Req() req: Request, @Param('id') id: string): Promise<{ ok: boolean }> {
    const actor = await this.actorResolver.resolve(req);
    await this.agent.deleteThread(actor, id);
    return { ok: true };
  }

  @Post(':id/fork-from/:messageId')
  async fork(@Req() req: Request, @Param('id') id: string, @Param('messageId') messageId: string) {
    const actor = await this.actorResolver.resolve(req);
    return this.agent.forkThread(actor, id, messageId);
  }
}
