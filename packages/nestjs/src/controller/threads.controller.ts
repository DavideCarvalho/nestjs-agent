import { AGENT_ACTOR_RESOLVER, type ActorResolver } from '@dudousxd/nestjs-agent-core';
import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { AgentService } from '../agent.service.js';

interface UpdateThreadBody {
  title?: string;
  /** `null` clears the thread's default agent. Omitted → left untouched. */
  defaultAgent?: string | null;
}

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

  /**
   * Renames the thread and/or sets its default agent. `defaultAgent` is only present in the request
   * body when the client actually sent the key (JSON has no `undefined`), so `'defaultAgent' in body`
   * distinguishes "leave it alone" from "set it to null" (clear it) unambiguously.
   */
  @Patch(':id')
  async update(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: UpdateThreadBody,
  ): Promise<{ ok: boolean }> {
    const actor = await this.actorResolver.resolve(req);
    await this.agent.updateThread(actor, id, {
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...('defaultAgent' in body ? { defaultAgent: body.defaultAgent ?? null } : {}),
    });
    return { ok: true };
  }

  @Post(':id/promote')
  async promote(@Req() req: Request, @Param('id') id: string): Promise<{ ok: boolean }> {
    const actor = await this.actorResolver.resolve(req);
    await this.agent.promoteThread(actor, id);
    return { ok: true };
  }

  @Delete(':id/from/:messageId')
  async truncateFrom(
    @Req() req: Request,
    @Param('id') id: string,
    @Param('messageId') messageId: string,
  ): Promise<{ ok: boolean }> {
    const actor = await this.actorResolver.resolve(req);
    await this.agent.truncateThreadFrom(actor, id, messageId);
    return { ok: true };
  }
}
