import {
  AGENT_ACTOR_RESOLVER,
  type ActionProposalView,
  type ActorResolver,
  CanAnyone,
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
} from '@nestjs/common';
import type { Request } from 'express';
import {
  type CursorPageResponse,
  cursorPage,
  parseCursorParams,
  rejectUnknownParams,
} from '../list-api/list-api.js';
import { ActionProposalService } from './action-proposal.service.js';

/** Proposals per page when the request sends no `first`. */
export const ACTION_PROPOSAL_PAGE_SIZE = 100;
/** The largest `first` honoured (the store's own ceiling); bigger values are clamped. */
export const ACTION_PROPOSAL_MAX_PAGE_SIZE = 1000;

type ActionProposalCursor = NonNullable<ListActionProposals['after']>;

/** The keyset `{ createdAt, id }` as an opaque, URL-safe cursor. */
export function encodeActionProposalCursor(after: ActionProposalCursor): string {
  return Buffer.from(JSON.stringify([after.createdAt, after.id]), 'utf8').toString('base64url');
}

/** The keyset an {@link encodeActionProposalCursor} cursor carries; `null` when it is malformed. */
export function decodeActionProposalCursor(cursor: string): ActionProposalCursor | null {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) return null;
  const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  if (!Array.isArray(parsed) || parsed.length !== 2) return null;
  const [createdAt, id] = parsed as [unknown, unknown];
  if (typeof createdAt !== 'number' || typeof id !== 'string') return null;
  const after = { createdAt, id };
  validateActionProposalListQuery({ after });
  return after;
}
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
@CanAnyone()
@Controller('threads/:threadId/action-proposals')
export class ActionProposalController {
  constructor(
    private readonly proposals: ActionProposalService,
    @Inject(AGENT_ACTOR_RESOLVER) private readonly actors: ActorResolver,
  ) {}
  /**
   * `GET <base>/threads/:threadId/action-proposals?after=&first=` — a cursor list in creation order:
   * `{ data, meta: { nextCursor, prevCursor, hasNext, hasPrev } }`. `first` defaults to
   * {@link ACTION_PROPOSAL_PAGE_SIZE} and is capped at {@link ACTION_PROPOSAL_MAX_PAGE_SIZE}. A page
   * holds only the proposals this actor may see, so it can be shorter than `first` and still have a
   * next page: follow `meta.nextCursor` until it is `null`. Forward only — there is no `before`.
   */
  @Get() async list(
    @Param('threadId') threadId: string,
    @Req() request: Request,
    @Query() query: Record<string, unknown>,
  ): Promise<CursorPageResponse<ActionProposalView>> {
    rejectUnknownParams(query, ['after', 'first']);
    const { size, decoded } = parseCursorParams(query, {
      defaultSize: ACTION_PROPOSAL_PAGE_SIZE,
      maxSize: ACTION_PROPOSAL_MAX_PAGE_SIZE,
      decode: decodeActionProposalCursor,
    });
    const page = await this.proposals.listPage(threadId, await this.actors.resolve(request), {
      limit: size,
      ...(decoded !== undefined ? { after: decoded } : {}),
    });
    return cursorPage(page.items, {
      nextCursor: page.next === undefined ? null : encodeActionProposalCursor(page.next),
      prevCursor: null,
    });
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
