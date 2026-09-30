import type { AgentAttachmentConfig, AttachmentStagingStore } from '@dudousxd/nestjs-agent-core';
import type { AgentModuleOptions } from './agent.options.js';

/** Default per-file size cap (20 MiB). */
export const DEFAULT_MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/** Default allowlist: what multimodal model providers commonly accept as native image/file parts. */
export const DEFAULT_ALLOWED_ATTACHMENT_CONTENT_TYPES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/plain',
  'text/csv',
];

/** How many attachments one message may name. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;

/** The attachment rules in force — `AgentAttachmentConfig`, as `GET <base>/config` serves it. */
export type AttachmentLimits = AgentAttachmentConfig;

/**
 * One source for attachment limits: the staging store's own `describe()` when it declares them
 * (`AgentMediaAttachmentsModule` does), else `AgentModule`'s `attachments` option, else the defaults.
 */
export function attachmentLimits(
  options: Pick<AgentModuleOptions, 'attachments'> | undefined,
  staging: AttachmentStagingStore | undefined,
): AttachmentLimits {
  const declared = staging?.describe?.();
  const own = options?.attachments;
  return {
    enabled: staging !== undefined,
    upload: staging === undefined ? null : (declared?.upload ?? 'multipart'),
    maxBytes: declared?.maxBytes ?? own?.maxBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES,
    allowedContentTypes:
      declared?.allowedContentTypes ??
      own?.allowedContentTypes ??
      DEFAULT_ALLOWED_ATTACHMENT_CONTENT_TYPES,
    maxPerMessage: MAX_ATTACHMENTS_PER_MESSAGE,
  };
}
