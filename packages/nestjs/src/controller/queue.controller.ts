import {
  AGENT_ACTOR_RESOLVER,
  type ActorResolver,
  type AttachmentRef,
  type ChatQueueState,
} from '@dudousxd/nestjs-agent-core';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { AgentService } from '../agent.service.js';
import { attachmentRefs } from './chat.controller.js';

interface UpdateQueuedMessageBody {
  /** The new text. */
  message?: unknown;
  /** `[{ mediaId }]` refs replacing the message's attachments; `null` or `[]` drops them. */
  attachments?: unknown;
  /** Move the message to this 0-based place in the queue. */
  position?: unknown;
}

/**
 * The thread message queue: messages sent while a turn was running, waiting to run after it. Every
 * route is ownership-gated like the thread routes, and answers the thread's queue as it now stands
 * (`{ items, paused }`). A change is also announced to whoever is streaming the thread, as a `queue`
 * frame in the running turn's stream.
 */
@Controller()
export class QueueController {
  constructor(
    private readonly agent: AgentService,
    @Inject(AGENT_ACTOR_RESOLVER) private readonly actorResolver: ActorResolver,
  ) {}

  @Get('threads/:id/queue')
  async list(@Req() req: Request, @Param('id') id: string): Promise<ChatQueueState> {
    return this.agent.getQueue(await this.actorResolver.resolve(req), id);
  }

  @Delete('threads/:id/queue')
  async clear(@Req() req: Request, @Param('id') id: string): Promise<ChatQueueState> {
    return this.agent.clearQueue(await this.actorResolver.resolve(req), id);
  }

  /** Lift a pause; the head starts when nothing is running. Carries `runId` when it started. */
  @Post('threads/:id/queue/resume')
  async resume(
    @Req() req: Request,
    @Param('id') id: string,
  ): Promise<ChatQueueState & { runId?: string }> {
    return this.agent.resumeQueue(await this.actorResolver.resolve(req), id);
  }

  @Patch('queue/:messageId')
  async update(
    @Req() req: Request,
    @Param('messageId') messageId: string,
    @Body() body: UpdateQueuedMessageBody,
  ): Promise<ChatQueueState> {
    const actor = await this.actorResolver.resolve(req);
    if (body.message !== undefined && typeof body.message !== 'string') {
      throw new BadRequestException('message must be a string');
    }
    if (body.position !== undefined && typeof body.position !== 'number') {
      throw new BadRequestException('position must be a number');
    }
    const attachments: AttachmentRef[] | null | undefined =
      body.attachments === undefined
        ? undefined
        : body.attachments === null
          ? null
          : attachmentRefs(body.attachments);
    return this.agent.updateQueuedMessage(actor, messageId, {
      ...(body.message !== undefined ? { message: body.message } : {}),
      ...(attachments !== undefined ? { attachments } : {}),
      ...(body.position !== undefined ? { position: body.position } : {}),
    });
  }

  /**
   * Run a waiting message now: it moves to the head as an interrupt and the running turn is
   * cancelled for it. Carries `interrupting` (the cancelled run), or `runId` when nothing was
   * running and it started at once.
   */
  @Post('queue/:messageId/interrupt')
  async interrupt(
    @Req() req: Request,
    @Param('messageId') messageId: string,
  ): Promise<ChatQueueState & { runId?: string; interrupting?: string }> {
    return this.agent.interruptQueuedMessage(await this.actorResolver.resolve(req), messageId);
  }

  @Delete('queue/:messageId')
  async remove(
    @Req() req: Request,
    @Param('messageId') messageId: string,
  ): Promise<ChatQueueState> {
    return this.agent.removeQueuedMessage(await this.actorResolver.resolve(req), messageId);
  }
}
