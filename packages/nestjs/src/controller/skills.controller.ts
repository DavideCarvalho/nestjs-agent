import {
  AGENT_ACTOR_RESOLVER,
  AGENT_SKILLS,
  type ActorResolver,
  type SkillCatalogEntry,
  type SkillsConfig,
  offerSkills,
} from '@dudousxd/nestjs-agent-core';
import { Controller, Get, Inject, Optional, Query, Req } from '@nestjs/common';
import type { Request } from 'express';

/**
 * Lists the skills available to THIS caller right now, scope-resolved — so a composer can offer them
 * after a `/` instead of hardcoding a list, and a settings screen can show which scope each came
 * from.
 *
 * THE SAME LIST THE MODEL IS OFFERED, built by the same call (`offerSkills`) against the same
 * provider and the same resolver. A second implementation of "which skills apply" would drift the
 * first time either was edited, and the drift would read to a user as a skill they can invoke that
 * the agent then says it has never heard of.
 *
 * Ownership posture mirrors `GET /agent/agents`: a plain array, no envelope, and nothing the caller
 * can pass to widen it — the actor comes from the resolver, never from a parameter.
 */
@Controller('skills')
export class SkillsController {
  constructor(
    @Inject(AGENT_ACTOR_RESOLVER) private readonly actorResolver: ActorResolver,
    // Optional: bound to `undefined` when the host configured no skills, which is a valid wiring
    // rather than a missing dependency — the endpoint then answers with an empty list.
    @Optional() @Inject(AGENT_SKILLS) private readonly skills: SkillsConfig | undefined,
  ) {}

  @Get()
  async list(
    @Req() req: Request,
    /**
     * The thread this list is for. Only ever handed to the host's own resolver and provider, which
     * may scope a skill to a conversation; nothing here reads the thread, so an unknown id widens
     * nothing. Omitted → the empty string, the same value a turn on a brand-new thread carries.
     */
    @Query('threadId') threadId?: string,
  ): Promise<SkillCatalogEntry[]> {
    if (this.skills === undefined) {
      return [];
    }
    const actor = await this.actorResolver.resolve(req);
    const offer = await offerSkills(this.skills, { actor, threadId: threadId ?? '' });
    return offer.entries;
  }
}
