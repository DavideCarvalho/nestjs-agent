import {
  AGENT_ACTOR_RESOLVER,
  AGENT_ATTACHMENT_STAGING,
  AGENT_MODEL_CATALOG,
  AGENT_OPTIONS,
  type ActorResolver,
  type AgentClientConfig,
  type AttachmentStagingStore,
  type ModelCatalog,
} from '@dudousxd/nestjs-agent-core';
import { Controller, Get, Inject, Optional, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { AgentModuleOptions } from '../agent.options.js';
import { attachmentLimits } from '../attachment-limits.js';
import { AnonymousActorResolver } from '../resolver/anonymous-actor-resolver.js';

@Controller('config')
export class ConfigController {
  constructor(
    @Inject(AGENT_OPTIONS) private readonly options: AgentModuleOptions,
    @Inject(AGENT_ACTOR_RESOLVER) private readonly actorResolver: ActorResolver,
    @Optional()
    @Inject(AGENT_ATTACHMENT_STAGING)
    private readonly staging: AttachmentStagingStore | undefined,
    @Optional()
    @Inject(AGENT_MODEL_CATALOG)
    private readonly models: ModelCatalog | undefined,
  ) {}

  @Get()
  async config(@Req() req: Request): Promise<AgentClientConfig> {
    // Resolved like every other route: the same guards apply, and an anonymous browser gets its
    // identity on the first request whichever route that is.
    await this.actorResolver.resolve(req);
    return {
      attachments: attachmentLimits(this.options, this.staging),
      models: { enabled: this.models !== undefined },
      quota: { enforced: this.options.quota !== undefined },
      identity: { anonymous: this.actorResolver instanceof AnonymousActorResolver },
    };
  }
}
