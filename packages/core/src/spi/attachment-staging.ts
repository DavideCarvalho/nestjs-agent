import type { Actor, MessageAttachment } from '../types.js';

/** Input to {@link AttachmentStagingStore.stage} — the raw bytes plus who uploaded them. */
export interface StageAttachmentInput {
  data: Buffer;
  filename: string;
  contentType: string;
  sizeBytes: number;
  actor: Actor;
}

/**
 * Optional upload-side seam for message attachments (an image/PDF a user attaches to a chat
 * message before the model ever sees it). The lib never fetches bytes itself — {@link MessageAttachment.url}
 * must already be reachable by the model provider — so something has to turn an uploaded file into
 * that URL first. A store adapter (or a thin wrapper over the host's own media pipeline) implements
 * this; consumers inject via `AGENT_ATTACHMENT_STAGING`. Unbound, the optional `POST /agent/attachments`
 * upload controller is never mounted.
 */
export interface AttachmentStagingStore {
  /**
   * Persist an uploaded file somewhere the model can later fetch (presigned URL etc.) and return the
   * {@link MessageAttachment} to send with the next chat message. The lib never fetches bytes; the
   * returned url must be reachable by the model provider.
   */
  stage(input: StageAttachmentInput): Promise<MessageAttachment>;
}
