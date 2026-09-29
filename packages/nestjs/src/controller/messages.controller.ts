import {
  AGENT_ACTOR_RESOLVER,
  type ActorResolver,
  type MessageFeedback,
  type MessageFeedbackValue,
} from '@dudousxd/nestjs-agent-core';
import { Body, Controller, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { AgentService } from '../agent.service.js';

interface FeedbackBody {
  /** `null` clears the rating. */
  value: MessageFeedbackValue | null;
  comment?: string;
}

@Controller('messages')
export class MessagesController {
  constructor(
    private readonly agent: AgentService,
    @Inject(AGENT_ACTOR_RESOLVER) private readonly actorResolver: ActorResolver,
  ) {}

  /**
   * Rate a message: `{ value: 'up' | 'down' | null, comment? }`. Answers the stored rating
   * (`{ feedback: null }` once cleared). Only the thread's owner may rate its messages.
   */
  @Post(':id/feedback')
  @HttpCode(200)
  async feedback(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: FeedbackBody,
  ): Promise<{ feedback: MessageFeedback | null }> {
    const actor = await this.actorResolver.resolve(req);
    const feedback = await this.agent.setMessageFeedback(actor, id, {
      value: body?.value ?? null,
      ...(body?.comment !== undefined ? { comment: body.comment } : {}),
    });
    return { feedback };
  }
}
