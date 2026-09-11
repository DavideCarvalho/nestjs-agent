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
 * All a chat turn may say about a file it attaches: the id of something already staged. Everything
 * else about the attachment (url, content type, name) is read back from the staging store, never
 * from the request — see {@link AttachmentStagingStore.resolve}.
 */
export interface AttachmentRef {
  mediaId: string;
}

/** Input to {@link AttachmentStagingStore.resolve} — the claimed id plus who is claiming it. */
export interface ResolveAttachmentInput {
  mediaId: string;
  actor: Actor;
}

/**
 * One entry in an actor's staged-media inventory: enough to show the file and to decide whether it
 * has aged out, and nothing more.
 *
 * Carries no url, unlike {@link MessageAttachment}. A url is minted per turn by
 * {@link AttachmentStagingStore.resolve} precisely so it can be short-lived; a listing that handed
 * one back would mint a fetchable url for every entry on the page, for a caller that asked to see
 * a file list. Whoever needs the bytes goes through `resolve` and is checked there.
 */
export interface StagedAttachment {
  mediaId: string;
  /** Original filename, as `stage` received it. */
  name: string;
  contentType: string;
  sizeBytes: number;
  /** ISO-8601 UTC instant the bytes were staged — what an age threshold is measured against. */
  createdAt: string;
}

/** Input to {@link AttachmentStagingStore.list} — whose inventory, and how much of it. */
export interface ListStagedAttachmentsInput {
  actor: Actor;
  /**
   * Only media staged strictly before this ISO-8601 UTC instant. This is how a caller expresses
   * "old enough to be worth looking at": freshly staged media belongs to an upload the user has
   * not sent yet, which is in flight rather than garbage. The instant comes from the caller
   * because how long a composer may sit open is the host's knowledge, not this library's.
   */
  stagedBefore?: string;
  /** Cap on entries returned, newest first. */
  limit?: number;
}

/**
 * Optional upload-side seam for message attachments (an image/PDF a user attaches to a chat
 * message before the model ever sees it). The lib never fetches bytes itself — {@link MessageAttachment.url}
 * must already be reachable by the model provider — so something has to turn an uploaded file into
 * that URL first. A store adapter (or a thin wrapper over the host's own media pipeline) implements
 * this; consumers inject via `AGENT_ATTACHMENT_STAGING`. Unbound, the optional `POST /agent/attachments`
 * upload controller is never mounted, and a chat turn cannot carry attachments at all.
 */
export interface AttachmentStagingStore {
  /**
   * Persist an uploaded file somewhere the model can later fetch (presigned URL etc.) and return the
   * {@link MessageAttachment} to send with the next chat message. The lib never fetches bytes; the
   * returned url must be reachable by the model provider.
   */
  stage(input: StageAttachmentInput): Promise<MessageAttachment>;
  /**
   * Turn a `mediaId` a chat turn claims back into the attachment to send with it, or `null` when
   * the id is unknown OR is not this actor's. The two cases are deliberately indistinguishable, so
   * the chat endpoint cannot be used to probe which media ids exist.
   *
   * SECURITY: this is the ONLY source of a url the model provider will be asked to fetch. The chat
   * endpoint discards every other field a client sends and rebuilds each attachment from here — an
   * implementation that echoes back a url taken from the request reopens the SSRF this seam exists
   * to close. Called once per turn, so a short-lived presigned url is minted fresh rather than
   * replayed stale.
   */
  resolve(input: ResolveAttachmentInput): Promise<MessageAttachment | null>;
  /**
   * OPTIONAL: the actor's staged media, newest first. The host staged these bytes, so only the host
   * can enumerate them — this library holds references, never an inventory.
   *
   * Pairs with {@link import('./agent-store.js').AgentStore.referencedMediaIds}, which answers the
   * half only the library can: of these ids, which a live message still carries. Together they are
   * a sweep — inventory minus references, restricted to entries old enough not to be an upload in
   * flight. Deleting whatever is left is the host's call and the host's alone; this library never
   * removes a host's bytes.
   *
   * Scoped to `input.actor` without exception. An implementation that ignores it turns a file list
   * into a way to read someone else's documents.
   *
   * `stagedBefore` and `limit` are the store's to apply — but a caller on a delete path must not
   * assume they were, since getting that wrong deletes files. `AgentService.collectableAttachments`
   * re-applies the age cut on the results for that reason.
   *
   * Absent on a store that predates this: there is no inventory to fall back on, so listing and
   * collection are simply unavailable (the read surface answers 501) rather than quietly empty —
   * an empty inventory and an unanswerable one look identical and mean opposite things.
   */
  list?(input: ListStagedAttachmentsInput): Promise<StagedAttachment[]>;
}
