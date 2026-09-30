import { AGENT_ACTOR_RESOLVER, type ActorResolver } from '@dudousxd/nestjs-agent-core';
import { BadRequestException, Body, Controller, Inject, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { AgentService } from '../agent.service.js';

/**
 * Bounds on a human reply. A reply is journaled and re-read on every replay of the run it settles,
 * so a payload the loop cannot read is not a failed request — it is a run that fails identically
 * forever, burning its retries. Nothing here is signalled until it has been checked.
 */
const MAX_ANSWERED_QUESTIONS = 100;
const MAX_VALUES_PER_QUESTION = 100;
const MAX_ANSWER_VALUE_LENGTH = 4096;
/** A rejection reason is read back by the model as the tool's result, so it is prompt input. */
const MAX_REJECT_REASON_LENGTH = 4096;

/** A `via` is provenance, persisted on the call — bounded like any other stored label. */
const MAX_VIA_LENGTH = 64;
/** What an HTTP decision is recorded as having come through when the caller names nothing. */
const DEFAULT_VIA = 'web';

interface ApproveBody {
  toolCallId: unknown;
  /** Approve later calls of the same tool in the same thread without asking. */
  remember?: unknown;
  /** The surface the decision came through. Defaults to `'web'`. */
  via?: unknown;
}
interface RejectBody {
  toolCallId: unknown;
  reason?: unknown;
  via?: unknown;
}
interface AnswerBody {
  toolCallId: unknown;
  /**
   * questionId → chosen option values. Omit a question (or the whole object) to take the pre-picked
   * default the request was shown with — confirming is meant to be enough, so an empty body is a
   * valid submission rather than an error.
   */
  answers?: unknown;
  /** The surface the answer came through. Defaults to `'web'`. */
  via?: unknown;
}

function toolCallId(claimed: unknown): string {
  if (typeof claimed !== 'string' || claimed.length === 0) {
    throw new BadRequestException('toolCallId must be a non-empty string');
  }
  return claimed;
}

function rejectReason(claimed: unknown): string | undefined {
  if (claimed === undefined) {
    return undefined;
  }
  if (typeof claimed !== 'string') {
    throw new BadRequestException('reason must be a string');
  }
  if (claimed.length > MAX_REJECT_REASON_LENGTH) {
    throw new BadRequestException(`reason must be at most ${MAX_REJECT_REASON_LENGTH} characters`);
  }
  return claimed;
}

function remember(claimed: unknown): boolean {
  if (claimed === undefined) {
    return false;
  }
  if (typeof claimed !== 'boolean') {
    throw new BadRequestException('remember must be a boolean');
  }
  return claimed;
}

function via(claimed: unknown): string {
  if (claimed === undefined) {
    return DEFAULT_VIA;
  }
  if (typeof claimed !== 'string' || claimed.length === 0 || claimed.length > MAX_VIA_LENGTH) {
    throw new BadRequestException(`via must be a string of 1-${MAX_VIA_LENGTH} characters`);
  }
  return claimed;
}

function answers(claimed: unknown): Record<string, string[]> | undefined {
  if (claimed === undefined) {
    return undefined;
  }
  if (typeof claimed !== 'object' || claimed === null || Array.isArray(claimed)) {
    throw new BadRequestException('answers must be an object of questionId → chosen values');
  }
  const entries = Object.entries(claimed);
  if (entries.length > MAX_ANSWERED_QUESTIONS) {
    throw new BadRequestException(`answers may cover at most ${MAX_ANSWERED_QUESTIONS} questions`);
  }
  // Null-prototype accumulator: a JSON body's own `__proto__` key would otherwise reach
  // Object.prototype's setter and silently drop the answer instead of carrying it.
  const validated: Record<string, string[]> = Object.create(null);
  for (const [questionId, values] of entries) {
    if (!Array.isArray(values)) {
      throw new BadRequestException(`answers["${questionId}"] must be an array of chosen values`);
    }
    if (values.length > MAX_VALUES_PER_QUESTION) {
      throw new BadRequestException(
        `answers["${questionId}"] may carry at most ${MAX_VALUES_PER_QUESTION} values`,
      );
    }
    for (const value of values) {
      if (typeof value !== 'string') {
        throw new BadRequestException(`answers["${questionId}"] must contain only strings`);
      }
      if (value.length > MAX_ANSWER_VALUE_LENGTH) {
        throw new BadRequestException(
          `answers["${questionId}"] values must be at most ${MAX_ANSWER_VALUE_LENGTH} characters`,
        );
      }
    }
    validated[questionId] = values as string[];
  }
  return validated;
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
    await this.agent.approve(actor, toolCallId(body.toolCallId), {
      remember: remember(body.remember),
      via: via(body.via),
    });
    return { ok: true };
  }

  @Post('reject')
  async reject(@Req() req: Request, @Body() body: RejectBody): Promise<{ ok: boolean }> {
    const actor = await this.actorResolver.resolve(req);
    await this.agent.reject(actor, toolCallId(body.toolCallId), rejectReason(body.reason), {
      via: via(body.via),
    });
    return { ok: true };
  }

  /**
   * Settle a parked question set. Alongside `approve`/`reject` rather than under a surface of its
   * own: an elicitation IS a parked tool call, gated by the same ownership check and delivered
   * through the same signal.
   */
  @Post('answer')
  async answer(@Req() req: Request, @Body() body: AnswerBody): Promise<{ ok: boolean }> {
    const actor = await this.actorResolver.resolve(req);
    await this.agent.answer(actor, toolCallId(body.toolCallId), answers(body.answers), {
      via: via(body.via),
    });
    return { ok: true };
  }

  /** Decline to answer and let the agent proceed on the answers it pre-picked. */
  @Post('skip')
  async skip(
    @Req() req: Request,
    @Body() body: { toolCallId: unknown; via?: unknown },
  ): Promise<{ ok: boolean }> {
    const actor = await this.actorResolver.resolve(req);
    await this.agent.skip(actor, toolCallId(body.toolCallId), { via: via(body.via) });
    return { ok: true };
  }
}
