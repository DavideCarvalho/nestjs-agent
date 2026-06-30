import { Body, Controller, Delete, Get, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { AgentService } from '../agent.service.js';
import { resolveActor } from '../util/actor.js';

@Controller('agent/threads')
export class ThreadsController {
  constructor(private readonly agent: AgentService) {}

  @Get()
  list(@Req() req: Request) {
    return this.agent.listThreads(resolveActor(req).id);
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
