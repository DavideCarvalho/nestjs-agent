import {
  AGENT_ACTOR_RESOLVER,
  type ActorResolver,
  type ListActionProposals,
  validateActionProposalListQuery,
} from '@dudousxd/nestjs-agent-core';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ActionProposalService } from './action-proposal.service.js';
function bodyFields(body: unknown, field: 'remember' | 'reason'): Record<string, unknown> {
  if (body === undefined) return {};
  if (
    typeof body !== 'object' ||
    body === null ||
    Array.isArray(body) ||
    Object.keys(body).some((key) => key !== field)
  )
    throw new BadRequestException(`Only ${field} is accepted`);
  const value = body as Record<string, unknown>;
  if (
    value[field] !== undefined &&
    ((field === 'remember' && typeof value[field] !== 'boolean') ||
      (field === 'reason' && typeof value[field] !== 'string'))
  )
    throw new BadRequestException(`Invalid ${field}`);
  return value;
}
@Controller('threads/:threadId/action-proposals')
export class ActionProposalController {
  constructor(
    private readonly proposals: ActionProposalService,
    @Inject(AGENT_ACTOR_RESOLVER) private readonly actors: ActorResolver,
  ) {}
  @Get() async list(
    @Param('threadId') threadId: string,
    @Req() request: Request,
    @Query('after') cursor: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    let query: Pick<ListActionProposals, 'after'> = {};
    if (cursor !== undefined) {
      try {
        if (typeof cursor !== 'string') throw new Error('Invalid cursor');
        query = { after: JSON.parse(cursor) };
        validateActionProposalListQuery(query);
      } catch {
        throw new BadRequestException('Invalid action proposal cursor');
      }
    }
    const page = await this.proposals.listPage(threadId, await this.actors.resolve(request), query);
    if (page.next) {
      response.setHeader('X-Action-Proposals-Next', encodeURIComponent(JSON.stringify(page.next)));
      const exposed = response.getHeader('Access-Control-Expose-Headers');
      response.setHeader(
        'Access-Control-Expose-Headers',
        `${exposed === undefined ? '' : `${String(exposed)}, `}X-Action-Proposals-Next`,
      );
    }
    return page.items;
  }
  @Post(':proposalId/approve') async approve(
    @Param('threadId') threadId: string,
    @Param('proposalId') proposalId: string,
    @Req() request: Request,
    @Body() body: unknown,
  ) {
    const value = bodyFields(body, 'remember');
    return this.proposals.decide(threadId, proposalId, await this.actors.resolve(request), {
      decision: 'approved',
      ...(typeof value.remember === 'boolean' ? { remember: value.remember } : {}),
    });
  }
  @Post(':proposalId/reject') async reject(
    @Param('threadId') threadId: string,
    @Param('proposalId') proposalId: string,
    @Req() request: Request,
    @Body() body: unknown,
  ) {
    const value = bodyFields(body, 'reason');
    return this.proposals.decide(threadId, proposalId, await this.actors.resolve(request), {
      decision: 'rejected',
      ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
    });
  }
}
