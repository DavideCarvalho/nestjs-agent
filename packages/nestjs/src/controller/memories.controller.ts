import {
  AGENT_ACTOR_RESOLVER,
  AGENT_MEMORY,
  type ActorResolver,
  type MemoryConfig,
  type MemoryDigestEntry,
  memoryForgetVerdict,
  offerMemories,
} from '@dudousxd/nestjs-agent-core';
import {
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Optional,
  Param,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';

/**
 * What the assistant believes about THIS caller — and how they take one of those beliefs back.
 *
 * WHY THIS EXISTS WHERE `GET /agent/skills` HAS NO WRITE SIBLING. A skill is authored by a person
 * who already knows it exists; a memory is written by the agent, about someone who does not. So the
 * read-back is not a convenience on top of the feature, it IS half of the feature: a belief nobody
 * can inspect is one nobody can correct, and a belief nobody can delete is one the deployment keeps
 * whether or not it is true. That is also why `MemoryProvider.forget` is required rather than
 * optional — see `memory.ts`.
 */
@Controller('memories')
export class MemoriesController {
  constructor(
    @Inject(AGENT_ACTOR_RESOLVER) private readonly actorResolver: ActorResolver,
    // Optional: bound to `undefined` when the host configured no memory, which is a valid wiring
    // rather than a missing dependency — the endpoints then answer with an empty list.
    @Optional() @Inject(AGENT_MEMORY) private readonly memory: MemoryConfig | undefined,
  ) {}

  /**
   * Every memory this actor can reach, most specific first, each carrying its origin and whatever
   * wider value it outranks.
   *
   * DELIBERATELY IGNORES `maxMemories`. That ceiling is a budget on what one TURN carries; applying
   * it here would mean a person could not see — and so could not delete — a belief the assistant is
   * one write away from acting on again. Showing someone more than the model sees is harmless;
   * showing them less is the failure this endpoint exists to prevent.
   */
  @Get()
  async list(
    @Req() req: Request,
    /** Only ever handed to the host's own resolver and provider; nothing here reads the thread. */
    @Query('threadId') threadId?: string,
  ): Promise<MemoryDigestEntry[]> {
    if (this.memory === undefined) {
      return [];
    }
    const actor = await this.actorResolver.resolve(req);
    return (await this.unbounded(threadId ?? '', actor)).entries;
  }

  /**
   * Forget one. Authorized against the actor's OWN resolved list, the same way a `skill` load is
   * authorized against the turn's catalog: an id this actor cannot see is answered as missing rather
   * than refused, so the endpoint cannot be used to find out which memories exist about other people.
   */
  @Delete(':id')
  async forget(@Req() req: Request, @Param('id') id: string): Promise<{ forgotten: boolean }> {
    if (this.memory === undefined) {
      throw new NotFoundException('No memory is configured in this deployment.');
    }
    const actor = await this.actorResolver.resolve(req);
    const digest = await this.unbounded('', actor);
    const entry = digest.entries.find((candidate) => candidate.id === id);
    if (entry === undefined) {
      throw new NotFoundException(`No memory with id "${id}".`);
    }
    const verdict = memoryForgetVerdict({ record: entry, actor });
    if (!verdict.allowed) {
      throw new ForbiddenException(verdict.reason);
    }
    return {
      forgotten: await this.memory.provider.forget({ id: entry.id, ctx: { actor, threadId: '' } }),
    };
  }

  private async unbounded(threadId: string, actor: Awaited<ReturnType<ActorResolver['resolve']>>) {
    // biome-ignore lint/style/noNonNullAssertion: every caller checks `memory` first.
    const config = this.memory!;
    return await offerMemories({
      config: { ...config, maxMemories: Number.POSITIVE_INFINITY },
      ctx: { actor, threadId },
    });
  }
}
