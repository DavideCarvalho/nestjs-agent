/** The {@link import('./media-attachment-staging.js').MediaAttachmentStaging} instance — inject it for `remove()` in a sweep. */
export const AGENT_MEDIA_ATTACHMENTS = Symbol.for('@dudousxd/nestjs-agent:media-attachments');

/** The resolved {@link import('./media-attachments.options.js').AgentMediaAttachmentsOptions}. */
export const AGENT_MEDIA_ATTACHMENTS_OPTIONS = Symbol.for(
  '@dudousxd/nestjs-agent:media-attachments-options',
);
