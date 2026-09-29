import { randomUUID } from 'node:crypto';
import type {
  Actor,
  AgentStore,
  AttachmentStagingStore,
  ListStagedAttachmentsInput,
  MessageAttachment,
  ResolveAttachmentInput,
  StageAttachmentInput,
  StagedAttachment,
} from '@dudousxd/nestjs-agent-core';
import {
  type MediaRecord,
  type MediaStore,
  type ResumableUploadManager,
  type StorageManager,
  publishMedia,
} from '@dudousxd/nestjs-media';
import {
  BadRequestException,
  ConflictException,
  Logger,
  NotImplementedException,
  PayloadTooLargeException,
  UnprocessableEntityException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import {
  type AgentMediaAttachmentsOptions,
  DEFAULT_AGENT_MEDIA_COLLECTION,
  DEFAULT_AGENT_MEDIA_OWNER_TYPE,
  DEFAULT_AGENT_MEDIA_TUS_BASE_PATH,
  DEFAULT_AGENT_MEDIA_URL_TTL_SECONDS,
} from './media-attachments.options.js';

/**
 * Mirrors `DEFAULT_MAX_ATTACHMENT_BYTES` / `DEFAULT_ALLOWED_ATTACHMENT_CONTENT_TYPES` from the
 * `POST /agent/attachments` controller — restated rather than imported so this subpath never pulls
 * the root entry's classes into its own bundle.
 */
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const DEFAULT_ALLOWED_CONTENT_TYPES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/plain',
  'text/csv',
];

/** Where the record's bytes stand. Kept on `customProperties.agentAttachment`. */
interface AgentAttachmentState {
  status: 'pending' | 'ready';
  /** The tus session the bytes are streaming through, while `pending`. */
  uploadId?: string;
}

/** What {@link MediaAttachmentStaging} needs from `@dudousxd/nestjs-media`. */
export interface MediaAttachmentStagingDeps {
  storage: StorageManager;
  store: MediaStore;
  /** `null` when `MediaModule` has no `uploadSessions` — resumable uploads are then unavailable. */
  uploads: ResumableUploadManager | null;
  /** Lets media referenced from the actor's own thread resolve (see {@link MediaAttachmentStaging.resolve}). */
  agentStore?: AgentStore;
}

export interface BeginMediaUploadInput {
  actor: Actor;
  filename: string;
  contentType: string;
  /** Exact byte length of the file — tus needs it up front, and completion is checked against it. */
  size: number;
}

/** A tus session opened for one attachment. Stream the bytes to `location`, then complete. */
export interface BeginMediaUploadResult {
  /** The attachment's id — what the chat turn will send as `{ mediaId }`. */
  mediaId: string;
  /** The tus upload id. */
  uploadId: string;
  /** The tus resource to `PATCH` the bytes to (relative to the API origin). */
  location: string;
}

/**
 * {@link AttachmentStagingStore} backed by `@dudousxd/nestjs-media`: every chat attachment is a
 * media-library record (`ownerType` + the actor's id as owner, one collection), its bytes on a
 * media disk.
 *
 * Two ways in, one store:
 * - `beginUpload` → the client streams the bytes to nestjs-media's own tus endpoint → `completeUpload`
 *   (resumable, what `@dudousxd/nestjs-agent-react/media` drives);
 * - `stage` — what `POST /agent/attachments` calls with a buffered multipart file, when a host also
 *   mounts that route.
 *
 * The record exists from `beginUpload` on, so an upload abandoned half-way is in the actor's
 * inventory ({@link list}) and ages into `AgentService.collectableAttachments` like any unsent file.
 */
export class MediaAttachmentStaging implements AttachmentStagingStore {
  private readonly logger = new Logger(MediaAttachmentStaging.name);
  private readonly collection: string;
  private readonly ownerType: string;
  private readonly maxBytes: number;
  private readonly allowed: readonly string[];
  private readonly now: () => Date;
  private readonly newId: () => string;
  private warnedInline = false;

  constructor(
    private readonly deps: MediaAttachmentStagingDeps,
    private readonly options: AgentMediaAttachmentsOptions,
  ) {
    this.collection = options.collection ?? DEFAULT_AGENT_MEDIA_COLLECTION;
    this.ownerType = options.ownerType ?? DEFAULT_AGENT_MEDIA_OWNER_TYPE;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.allowed = options.allowedContentTypes ?? DEFAULT_ALLOWED_CONTENT_TYPES;
    this.now = options.clock ?? (() => new Date());
    this.newId = options.idGenerator ?? (() => randomUUID());
  }

  private get diskName(): string {
    return this.options.disk ?? this.deps.storage.defaultDisk;
  }

  /** Open a tus session for one file, owned by `actor`. Validation happens here, before any byte moves. */
  async beginUpload(input: BeginMediaUploadInput): Promise<BeginMediaUploadResult> {
    const uploads = this.deps.uploads;
    if (uploads === null) {
      throw new NotImplementedException(
        'Resumable attachment uploads need MediaModule configured with `uploadSessions` and `tus`.',
      );
    }
    this.validate(input.filename, input.contentType, input.size);
    const id = this.newId();
    const fileName = safeFileName(input.filename);
    const path = this.pathFor(input.actor, id, fileName);
    const session = await uploads.createUpload({
      disk: this.diskName,
      key: path,
      size: input.size,
      contentType: input.contentType,
      metadata: { agentMediaId: id },
    });
    await this.saveRecord({
      id,
      actor: input.actor,
      fileName,
      mimeType: input.contentType,
      size: input.size,
      path,
      state: { status: 'pending', uploadId: session.id },
    });
    const base = (this.options.tusBasePath ?? DEFAULT_AGENT_MEDIA_TUS_BASE_PATH).replace(
      /\/+$/,
      '',
    );
    return { mediaId: id, uploadId: session.id, location: `${base}/${session.id}` };
  }

  /**
   * Confirm the bytes of a `beginUpload` landed and whole. `null` for an unknown or foreign id;
   * `409` while the bytes are still missing; `422` (and the record dropped) when what arrived is
   * not the size that was declared. Idempotent on a ready record.
   */
  async completeUpload(input: {
    actor: Actor;
    mediaId: string;
  }): Promise<MessageAttachment | null> {
    const record = await this.ownRecord(input.mediaId, input.actor);
    if (record === null) return null;
    const ready = await this.ensureReady(record);
    if (ready === 'missing') {
      throw new ConflictException(`upload ${input.mediaId} has not finished`);
    }
    if (ready === 'mismatch') {
      await this.remove(record.id);
      throw new UnprocessableEntityException(
        `upload ${input.mediaId} does not match its declared size`,
      );
    }
    return this.toAttachment(ready, { forModel: false });
  }

  /** The actor drops one of their own attachments — aborting its upload if still in flight. */
  async discard(input: { actor: Actor; mediaId: string }): Promise<boolean> {
    const record = await this.ownRecord(input.mediaId, input.actor);
    if (record === null) return false;
    await this.remove(record.id);
    return true;
  }

  /**
   * Delete an attachment's bytes, its in-flight tus session and its record. NO ownership check —
   * the host's sweep calls this for what `AgentService.collectableAttachments` returned.
   */
  async remove(mediaId: string): Promise<void> {
    const record = await this.deps.store.find(mediaId);
    if (record === null || !this.isOurs(record)) return;
    const state = stateOf(record);
    if (state.status === 'pending' && state.uploadId !== undefined) {
      await this.deps.uploads?.abort(state.uploadId).catch(() => undefined);
    }
    await this.deps.storage
      .disk(record.disk)
      .delete(record.path)
      .catch(() => undefined);
    await this.deps.store.delete(record.id);
    if (this.options.indexForRag === true && state.status === 'ready') {
      publishMedia('delete', {
        id: record.id,
        ownerType: record.ownerType,
        ownerId: record.ownerId,
      });
    }
  }

  async stage(input: StageAttachmentInput): Promise<MessageAttachment> {
    const id = this.newId();
    const fileName = safeFileName(input.filename);
    const path = this.pathFor(input.actor, id, fileName);
    await this.deps.storage
      .disk(this.diskName)
      .put(path, input.data, { contentType: input.contentType });
    const record = await this.saveRecord({
      id,
      actor: input.actor,
      fileName,
      mimeType: input.contentType,
      size: input.sizeBytes,
      path,
      state: { status: 'ready' },
    });
    this.announce(record);
    return this.toAttachment(record, { forModel: false });
  }

  /**
   * The attachment for `mediaId`, or `null` when it is unknown, not this actor's, or its bytes have
   * not (fully) arrived. The actor may use media they own, and media a message in one of THEIR
   * threads already carries (a fork, a regenerate) — never anything else.
   */
  async resolve(input: ResolveAttachmentInput): Promise<MessageAttachment | null> {
    const record = await this.deps.store.find(input.mediaId);
    if (record === null || !this.isOurs(record)) return null;
    if (!(await this.canUse(record, input.actor))) return null;
    const ready = await this.ensureReady(record);
    if (typeof ready === 'string') return null;
    return this.toAttachment(ready, { forModel: true });
  }

  async list(input: ListStagedAttachmentsInput): Promise<StagedAttachment[]> {
    const records = await this.deps.store.listByOwner(
      this.ownerType,
      input.actor.id,
      this.collection,
    );
    const entries = records
      .map((record) => ({
        mediaId: record.id,
        name: record.fileName,
        contentType: record.mimeType,
        sizeBytes: record.size,
        createdAt: new Date(record.createdAt).toISOString(),
      }))
      .filter((entry) => input.stagedBefore === undefined || entry.createdAt < input.stagedBefore)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return input.limit === undefined ? entries : entries.slice(0, input.limit);
  }

  private validate(filename: string, contentType: string, size: number): void {
    if (typeof filename !== 'string' || filename.trim().length === 0) {
      throw new BadRequestException('filename is required');
    }
    if (typeof contentType !== 'string' || !this.allowed.includes(contentType)) {
      throw new UnsupportedMediaTypeException(
        `content type "${String(contentType)}" is not allowed (allowed: ${this.allowed.join(', ')})`,
      );
    }
    if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0) {
      throw new BadRequestException('size must be a positive integer byte count');
    }
    if (size > this.maxBytes) {
      throw new PayloadTooLargeException(`file exceeds the ${this.maxBytes}-byte limit`);
    }
  }

  private pathFor(actor: Actor, id: string, fileName: string): string {
    return `${this.ownerType}/${encodeURIComponent(actor.id)}/${this.collection}/${id}/${fileName}`;
  }

  private async saveRecord(input: {
    id: string;
    actor: Actor;
    fileName: string;
    mimeType: string;
    size: number;
    path: string;
    state: AgentAttachmentState;
  }): Promise<MediaRecord> {
    const timestamp = this.now();
    return this.deps.store.save({
      id: input.id,
      ownerType: this.ownerType,
      ownerId: input.actor.id,
      collection: this.collection,
      name: stripExtension(input.fileName),
      fileName: input.fileName,
      mimeType: input.mimeType,
      size: input.size,
      disk: this.diskName,
      path: input.path,
      order: await this.deps.store.nextOrder(this.ownerType, input.actor.id, this.collection),
      customProperties: { agentAttachment: input.state },
      conversions: {},
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }

  private isOurs(record: MediaRecord): boolean {
    return record.ownerType === this.ownerType && record.collection === this.collection;
  }

  private async ownRecord(mediaId: string, actor: Actor): Promise<MediaRecord | null> {
    const record = await this.deps.store.find(mediaId);
    if (record === null || !this.isOurs(record) || record.ownerId !== actor.id) return null;
    return record;
  }

  private async canUse(record: MediaRecord, actor: Actor): Promise<boolean> {
    if (record.ownerId === actor.id) return true;
    const referenced = this.deps.agentStore?.referencedMediaIds?.bind(this.deps.agentStore);
    if (referenced === undefined) return false;
    return (await referenced(actor.id, [record.id])).includes(record.id);
  }

  /**
   * A ready record as-is; a pending one promoted to ready once its bytes are on the disk at exactly
   * the declared size. `'missing'` while they are not; `'mismatch'` when they arrived at another size.
   */
  private async ensureReady(record: MediaRecord): Promise<MediaRecord | 'missing' | 'mismatch'> {
    if (stateOf(record).status === 'ready') return record;
    const disk = this.deps.storage.disk(record.disk);
    if (!(await disk.exists(record.path))) return 'missing';
    const size = await disk.size(record.path);
    if (size !== record.size || size > this.maxBytes) return 'mismatch';
    const ready = await this.deps.store.save({
      ...record,
      customProperties: { ...record.customProperties, agentAttachment: { status: 'ready' } },
      updatedAt: this.now(),
    });
    this.announce(ready);
    return ready;
  }

  private announce(record: MediaRecord): void {
    if (this.options.indexForRag !== true) return;
    publishMedia('attach', {
      id: record.id,
      ownerType: record.ownerType,
      ownerId: record.ownerId,
      collection: record.collection,
      disk: record.disk,
      path: record.path,
      size: record.size,
      mimeType: record.mimeType,
    });
  }

  /**
   * `forModel: false` is what goes back to the uploader: never inline bytes (they already have the
   * file), so an inline-only disk answers with an empty url there.
   */
  private async toAttachment(
    record: MediaRecord,
    { forModel }: { forModel: boolean },
  ): Promise<MessageAttachment> {
    const base = { mediaId: record.id, contentType: record.mimeType, name: record.fileName };
    const disk = this.deps.storage.disk(record.disk);
    if (this.options.resolveUrl !== undefined) {
      return { ...base, url: await this.options.resolveUrl(record, { disk }) };
    }
    if (this.options.visibility === 'public') {
      return { ...base, url: await disk.url(record.path) };
    }
    if (disk.capabilities.presign) {
      const ttl = this.options.urlExpiresInSeconds ?? DEFAULT_AGENT_MEDIA_URL_TTL_SECONDS;
      return {
        ...base,
        url: await disk.temporaryUrl(record.path, ttl, { responseContentType: record.mimeType }),
      };
    }
    if (!forModel) return { ...base, url: '' };
    if (!this.warnedInline) {
      this.warnedInline = true;
      this.logger.warn(
        `disk "${record.disk}" cannot presign urls: attachments reach the model inline (data: urls, persisted with each message). Use a presign-capable disk or resolveUrl in production.`,
      );
    }
    const bytes = await disk.get(record.path);
    return { ...base, url: `data:${record.mimeType};base64,${bytes.toString('base64')}` };
  }
}

function stateOf(record: MediaRecord): AgentAttachmentState {
  const state = record.customProperties.agentAttachment as AgentAttachmentState | undefined;
  return state ?? { status: 'ready' };
}

/** The last path segment, stripped of anything a disk would read as a directory or control. */
function safeFileName(filename: string): string {
  const last = filename.split(/[\\/]/).pop() ?? '';
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars is the point.
  const cleaned = last.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return cleaned === '' || cleaned === '.' || cleaned === '..' ? 'file' : cleaned;
}

function stripExtension(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? fileName.slice(0, dot) : fileName;
}
