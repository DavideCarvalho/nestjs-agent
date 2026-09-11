import {
  AGENT_ACTOR_RESOLVER,
  AGENT_ATTACHMENT_STAGING,
  AGENT_OPTIONS,
  type ActorResolver,
  type AttachmentStagingStore,
  type MessageAttachment,
  type StagedAttachment,
} from '@dudousxd/nestjs-agent-core';
import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  NotImplementedException,
  type OnModuleInit,
  Optional,
  PayloadTooLargeException,
  Post,
  Req,
  UnsupportedMediaTypeException,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import type { AgentModuleOptions } from '../agent.options.js';
import { AgentService } from '../agent.service.js';

/** Default per-file size cap when `AgentModuleOptions.attachments.maxBytes` is omitted (20 MiB). */
export const DEFAULT_MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/**
 * The most this route will ever read into memory, enforced by multer while the body streams (32
 * MiB — above the default cap, and above what any mainstream multimodal provider accepts as a
 * single file part). `attachments.maxBytes` is per-instance config and so cannot be known when the
 * interceptor is declared; it narrows this ceiling at request time but can never raise it.
 */
export const HARD_MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024;

/**
 * How many entries `GET /agent/attachments` returns. Fixed rather than caller-supplied: this route
 * exists so a composer can show the files someone has uploaded, and a host that needs real paging
 * over a large inventory has `AgentService.listAttachments` and its own store's `list` to page with.
 */
export const ATTACHMENT_PAGE_SIZE = 50;

/**
 * Default allowlist: what multimodal model providers commonly accept as native image/file parts.
 */
export const DEFAULT_ALLOWED_ATTACHMENT_CONTENT_TYPES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/plain',
  'text/csv',
];

/**
 * Optional `POST /agent/attachments` upload surface — mounted only when `AgentModuleOptions
 * .attachments.upload` (or the async config's `attachmentsUpload`) is `true` (see `agent.module.ts`).
 * Multipart single file field `'file'`, buffered in memory (no disk write — `FileInterceptor`'s
 * default storage) up to {@link HARD_MAX_ATTACHMENT_BYTES}, then validated against the configured
 * size cap + content-type allowlist and handed to the bound {@link AttachmentStagingStore} to
 * persist and turn into a model-fetchable URL. Both size gates answer `413`: the ceiling aborts the
 * upload mid-stream, the configured cap rejects what was read.
 *
 * `GET /agent/attachments` rides the same flag and returns the caller's own staged files as
 * metadata. Collection is NOT a route: a sweep needs a host-chosen age threshold and ends in the
 * host deleting bytes, so it stays an in-process call (`AgentService.collectableAttachments`)
 * rather than something reachable with a session cookie.
 */
@Controller('attachments')
export class AttachmentsController implements OnModuleInit {
  constructor(
    @Inject(AGENT_OPTIONS) private readonly options: AgentModuleOptions,
    @Inject(AGENT_ACTOR_RESOLVER) private readonly actorResolver: ActorResolver,
    private readonly agents: AgentService,
    @Optional()
    @Inject(AGENT_ATTACHMENT_STAGING)
    private readonly staging: AttachmentStagingStore | undefined,
  ) {}

  /**
   * `attachments.upload: true` is what mounts this controller at all (see `agent.module.ts`), so by
   * the time an instance exists the host clearly intends uploads to work. Fail boot loudly rather
   * than mounting a controller that would 501 on every single request because nobody bound
   * `AGENT_ATTACHMENT_STAGING`.
   */
  onModuleInit(): void {
    if (this.options.attachments?.upload === true && this.staging === undefined) {
      throw new Error(
        'AgentModule: attachments.upload is true but no AGENT_ATTACHMENT_STAGING provider is bound. ' +
          'Bind one (e.g. `{ provide: AGENT_ATTACHMENT_STAGING, useClass: MyStagingStore }`) in a ' +
          'module imported alongside AgentModule, or set attachments.upload to false.',
      );
    }
  }

  /**
   * The caller's own staged files, newest first — the one question `GET /agent/threads/:id` cannot
   * answer, since an upload that was never sent belongs to no thread.
   *
   * Scoped by the RESOLVED actor and nothing else. There is deliberately no `threadId` filter: a
   * thread's attachments already ride on its messages in the thread payload, and re-serving them
   * from here would add a second ownership path to get wrong for information the client already
   * holds. Metadata only — see {@link StagedAttachment}.
   */
  @Get()
  async list(@Req() req: Request): Promise<StagedAttachment[]> {
    const actor = await this.actorResolver.resolve(req);
    return this.agents.listAttachments(actor, { limit: ATTACHMENT_PAGE_SIZE });
  }

  @Post()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: HARD_MAX_ATTACHMENT_BYTES } }))
  async upload(
    @Req() req: Request,
    @UploadedFile() file: Express.Multer.File | undefined,
  ): Promise<MessageAttachment> {
    if (this.staging === undefined) {
      // Reachable only if the module was built with attachments.upload left false/omitted while
      // this controller was somehow still wired up by hand — the normal boot path prevents this via
      // onModuleInit above. Kept as defense in depth with a precise status instead of a stack trace.
      throw new NotImplementedException('Attachment upload is not configured on this server.');
    }
    if (file === undefined) {
      throw new BadRequestException('multipart field "file" is required');
    }
    const allowedContentTypes =
      this.options.attachments?.allowedContentTypes ?? DEFAULT_ALLOWED_ATTACHMENT_CONTENT_TYPES;
    if (!allowedContentTypes.includes(file.mimetype)) {
      throw new UnsupportedMediaTypeException(
        `content type "${file.mimetype}" is not allowed (allowed: ${allowedContentTypes.join(', ')})`,
      );
    }
    const maxBytes = this.options.attachments?.maxBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;
    if (file.size > maxBytes) {
      throw new PayloadTooLargeException(`file exceeds the ${maxBytes}-byte limit`);
    }
    const actor = await this.actorResolver.resolve(req);
    return this.staging.stage({
      data: file.buffer,
      filename: file.originalname,
      contentType: file.mimetype,
      sizeBytes: file.size,
      actor,
    });
  }
}
