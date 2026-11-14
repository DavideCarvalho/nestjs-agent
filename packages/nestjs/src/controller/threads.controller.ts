import {
  AGENT_ACTOR_RESOLVER,
  type ActorResolver,
  CanAnyone,
  type ThreadSummary,
} from '@dudousxd/nestjs-agent-core';
import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { AgentService } from '../agent.service.js';
import { parsePageParams, rejectUnknownParams } from '../list-api/list-api.js';

/** Threads `GET <base>/threads` returns when the request sends no `size`. */
export const THREAD_LIST_SIZE = 50;
/** The largest `size` `GET <base>/threads` honours; bigger values are clamped. */
export const THREAD_LIST_MAX_SIZE = 200;

interface UpdateThreadBody {
  title?: string;
  /** `null` clears the thread's default agent. Omitted → left untouched. */
  defaultAgent?: string | null;
  /** `null` unpins the thread's model. Omitted → left untouched. Must be offered by the catalog. */
  model?: string | null;
  /** `null` clears the thread's persona. Omitted → left untouched. Must be one the agent declares. */
  persona?: string | null;
}

@CanAnyone()
@Controller('threads')
export class ThreadsController {
  constructor(
    private readonly agent: AgentService,
    @Inject(AGENT_ACTOR_RESOLVER) private readonly actorResolver: ActorResolver,
  ) {}

  /**
   * `{ data }`: the caller's `size` most recently updated threads. Not paged: `AgentStore.listThreads`
   * takes only a cap — no offset, keyset or count — so the honest wire is a sized list.
   */
  @Get()
  async list(
    @Req() req: Request,
    @Query() query: Record<string, unknown>,
  ): Promise<{ data: ThreadSummary[] }> {
    rejectUnknownParams(query, ['size']);
    const { size } = parsePageParams(query, {
      defaultSize: THREAD_LIST_SIZE,
      maxSize: THREAD_LIST_MAX_SIZE,
    });
    const actor = await this.actorResolver.resolve(req);
    return { data: await this.agent.listThreads(actor, { limit: size }) };
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
      ...('model' in body ? { model: body.model ?? null } : {}),
      ...('persona' in body ? { persona: body.persona ?? null } : {}),
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
