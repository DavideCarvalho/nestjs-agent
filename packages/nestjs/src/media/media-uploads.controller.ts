import {
  AGENT_ACTOR_RESOLVER,
  type ActorResolver,
  type MessageAttachment,
} from '@dudousxd/nestjs-agent-core';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import type { BeginMediaUploadResult, MediaAttachmentStaging } from './media-attachment-staging.js';
import { AGENT_MEDIA_ATTACHMENTS } from './tokens.js';

/**
 * The agent's half of a resumable chat upload. It never carries a byte: it opens an owned,
 * validated tus session on `MediaModule` (`POST`), confirms the bytes arrived (`POST :id/complete`)
 * and drops an attachment the user removed (`DELETE :id`). The bytes themselves go to
 * nestjs-media's own tus endpoint (`PATCH <tusBasePath>/:uploadId`), which the host guards through
 * `MediaModule`'s `guards`.
 *
 * Mounted at `<AgentModule path>/attachments/uploads`.
 */
@Controller('attachments/uploads')
export class AgentMediaUploadsController {
  constructor(
    @Inject(AGENT_ACTOR_RESOLVER) private readonly actorResolver: ActorResolver,
    @Inject(AGENT_MEDIA_ATTACHMENTS) private readonly staging: MediaAttachmentStaging,
  ) {}

  /** `{ filename, contentType, size }` → `{ mediaId, uploadId, location }`. */
  @Post()
  async begin(@Req() req: Request, @Body() body: unknown): Promise<BeginMediaUploadResult> {
    if (typeof body !== 'object' || body === null) {
      throw new BadRequestException('body must be { filename, contentType, size }');
    }
    const { filename, contentType, size } = body as Record<string, unknown>;
    const actor = await this.actorResolver.resolve(req);
    return this.staging.beginUpload({
      actor,
      filename: filename as string,
      contentType: contentType as string,
      size: size as number,
    });
  }

  @Post(':mediaId/complete')
  @HttpCode(200)
  async complete(
    @Req() req: Request,
    @Param('mediaId') mediaId: string,
  ): Promise<MessageAttachment> {
    const actor = await this.actorResolver.resolve(req);
    const attachment = await this.staging.completeUpload({ actor, mediaId });
    if (attachment === null) throw new NotFoundException(`attachment ${mediaId} not found`);
    return attachment;
  }

  @Delete(':mediaId')
  @HttpCode(204)
  async discard(@Req() req: Request, @Param('mediaId') mediaId: string): Promise<void> {
    const actor = await this.actorResolver.resolve(req);
    if (!(await this.staging.discard({ actor, mediaId }))) {
      throw new NotFoundException(`attachment ${mediaId} not found`);
    }
  }
}
