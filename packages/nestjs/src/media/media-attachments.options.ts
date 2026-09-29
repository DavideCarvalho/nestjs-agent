import type { Actor } from '@dudousxd/nestjs-agent-core';
import type { MediaRecord, StorageDriver } from '@dudousxd/nestjs-media';
import type {
  CanActivate,
  DynamicModule,
  InjectionToken,
  OptionalFactoryDependency,
  Type,
} from '@nestjs/common';

/** Default media-library collection chat attachments are filed under. */
export const DEFAULT_AGENT_MEDIA_COLLECTION = 'agent-attachments';

/** Default `ownerType` of the media records — the owner id is the actor's id. */
export const DEFAULT_AGENT_MEDIA_OWNER_TYPE = 'agent-actor';

/** Default lifetime of a presigned url handed to the model provider (7 days — S3's ceiling). */
export const DEFAULT_AGENT_MEDIA_URL_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Default tus base path — `MediaModule`'s own default for `tus.basePath`. */
export const DEFAULT_AGENT_MEDIA_TUS_BASE_PATH = '/media/uploads';

/** What {@link AgentMediaAttachmentsOptions.resolveUrl} is handed besides the record. */
export interface ResolveMediaUrlContext {
  /** The storage driver the record's bytes live on. */
  disk: StorageDriver;
}

/** What {@link AgentMediaAttachmentsOptions.canAccess} decides on. */
export interface MediaAttachmentAccessInput {
  record: MediaRecord;
  actor: Actor;
  /** The default verdict: the actor owns the record, or a message in their own thread carries it. */
  allowed: boolean;
}

export interface AgentMediaAttachmentsOptions {
  /** Media-library collection the records are filed under. Default `'agent-attachments'`. */
  collection?: string;
  /** `ownerType` of the records; `ownerId` is always the actor's id. Default `'agent-actor'`. */
  ownerType?: string;
  /** Storage disk the bytes land on. Default: the `MediaModule`'s default disk. */
  disk?: string;
  /** Per-file size cap. Default 20 MiB — the same as `POST /agent/attachments`. */
  maxBytes?: number;
  /**
   * Content types a chat may attach. Default: the same allowlist as `POST /agent/attachments`
   * (png/jpeg/gif/webp images, pdf, plain text, csv).
   */
  allowedContentTypes?: readonly string[];
  /**
   * How the model provider gets at the bytes.
   * - `'private'` (default): a presigned url (`temporaryUrl`) when the disk can mint one (S3), else
   *   the bytes inline as a `data:` url. Inline works everywhere but is persisted with the message —
   *   fine for local development, use a presign-capable disk (or `resolveUrl`) in production.
   * - `'public'`: the disk's stable public `url()` — only for a bucket the provider may read.
   */
  visibility?: 'private' | 'public';
  /** Lifetime of a presigned url, in seconds. Default 7 days. */
  urlExpiresInSeconds?: number;
  /**
   * Take over url minting entirely (e.g. a signed route on your own API). Wins over `visibility`.
   * SECURITY: the url is fetched server-side by the model provider — build it from the record only.
   */
  resolveUrl?: (record: MediaRecord, context: ResolveMediaUrlContext) => string | Promise<string>;
  /**
   * Who may send (resolve) a record in a chat turn. Default: `allowed` — the owner, or anyone whose
   * own thread already carries it. Return `allowed || …` to widen that (a shared team space),
   * `allowed && …` to narrow it. Only `resolve` consults this; completing and discarding an upload
   * stay the uploader's.
   */
  canAccess?: (input: MediaAttachmentAccessInput) => boolean | Promise<boolean>;
  /**
   * The public path of `MediaModule`'s tus endpoint (its `tus.basePath`, global prefix included) —
   * used to build the `location` a client streams the bytes to. Default `'/media/uploads'`.
   */
  tusBasePath?: string;
  /**
   * Announce each ready attachment on `aviary:media:attach` (and its removal on
   * `aviary:media:delete`), so `@dudousxd/nestjs-agent-rag-media` indexes it for retrieval. Off by
   * default: a chat attachment is private to the person who sent it, and indexing it is only safe
   * where retrieval is scoped by owner (`FilteredRetriever` on `ownerType`/`ownerId`).
   */
  indexForRag?: boolean;
  /** Injectable clock for tests. */
  clock?: () => Date;
  /** Injectable id generator for tests. Default `crypto.randomUUID`. */
  idGenerator?: () => string;
}

/** Build-time wiring shared by `forRoot` / `forRootAsync` — Nest mounts controllers before any factory runs. */
export interface AgentMediaAttachmentsMountOptions {
  /**
   * Route prefix — must match `AgentModule`'s `path`. The upload routes mount under
   * `<path>/attachments/uploads`. Default `'agent'`.
   */
  path?: string;
  /** Guards for the upload routes (mirror `AgentModule`'s `guards`). */
  guards?: Type<CanActivate>[];
  /**
   * Mount the resumable-upload routes. Default `true`. `false` keeps only the staging store — for a
   * host that opens tus sessions its own way and only wants resolve/list backed by media.
   */
  routes?: boolean;
}

export interface AgentMediaAttachmentsModuleOptions
  extends AgentMediaAttachmentsOptions,
    AgentMediaAttachmentsMountOptions {}

export interface AgentMediaAttachmentsAsyncOptions extends AgentMediaAttachmentsMountOptions {
  imports?: DynamicModule['imports'];
  inject?: Array<InjectionToken | OptionalFactoryDependency>;
  useFactory: (
    ...args: never[]
  ) => AgentMediaAttachmentsOptions | Promise<AgentMediaAttachmentsOptions>;
}
