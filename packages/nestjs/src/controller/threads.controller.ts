import { AGENT_ACTOR_RESOLVER, type ActorResolver } from '@dudousxd/nestjs-agent-core';
import { Body, Controller, Delete, Get, Inject, Param, Post, Req } from '@nestjs/common';
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

  @Get('personas/catalog')
  personas() {
    return this.agent.personaCatalog();
  }

  @Get(':id')
  detail(@Param('id') id: string) {
    return this.agent.getThread(id);
  }

  @Delete(':id')
  async remove(@Param('id') id: string): Promise<{ ok: boolean }> {
    await this.agent.deleteThread(id);
    return { ok: true };
  }

  @Post(':id/fork-from/:messageId')
  fork(@Param('id') id: string, @Param('messageId') messageId: string) {
    return this.agent.forkThread(id, messageId);
  }
}
