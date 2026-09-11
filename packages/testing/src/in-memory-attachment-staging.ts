import type {
  AttachmentStagingStore,
  ListStagedAttachmentsInput,
  MessageAttachment,
  ResolveAttachmentInput,
  StageAttachmentInput,
  StagedAttachment,
} from '@dudousxd/nestjs-agent-core';

interface StagedRow extends StagedAttachment {
  actorRef: string;
  data: Buffer;
}

export interface InMemoryAttachmentStagingOptions {
  /** Clock stamped onto `createdAt`. Override to stage media at a chosen instant. */
  now?: () => Date;
  /** Builds the url `resolve` hands back. Default: a stable `https://media.test/<mediaId>`. */
  urlFor?: (mediaId: string) => string;
}

/**
 * A fully in-memory {@link AttachmentStagingStore} for tests and the offline demo — the host half
 * of the attachment surface (it owns bytes), mirroring how {@link InMemoryAgentStore} stands in for
 * the library half (it owns references).
 *
 * Deliberately a complete implementation rather than a stub: `list` and the per-actor checks in
 * `resolve` are the parts a real host is most likely to get wrong, and a double that waves them
 * through would let a spec pass against a store that leaks other people's files.
 */
export class InMemoryAttachmentStagingStore implements AttachmentStagingStore {
  private readonly rows = new Map<string, StagedRow>();
  private now: () => Date;
  private readonly urlFor: (mediaId: string) => string;

  constructor(options: InMemoryAttachmentStagingOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.urlFor = options.urlFor ?? ((mediaId) => `https://media.test/${mediaId}`);
  }

  /** Test affordance: move the clock, so media can be staged days apart in one spec. */
  setClock(now: () => Date): void {
    this.now = now;
  }

  async stage(input: StageAttachmentInput): Promise<MessageAttachment> {
    const mediaId = crypto.randomUUID();
    this.rows.set(mediaId, {
      mediaId,
      actorRef: input.actor.id,
      name: input.filename,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      createdAt: this.now().toISOString(),
      data: input.data,
    });
    return this.toAttachment(mediaId, input.contentType, input.filename);
  }

  /** `null` for an unknown id AND for one belonging to another actor — the two must not be tellable apart. */
  async resolve(input: ResolveAttachmentInput): Promise<MessageAttachment | null> {
    const row = this.rows.get(input.mediaId);
    if (row === undefined || row.actorRef !== input.actor.id) {
      return null;
    }
    return this.toAttachment(row.mediaId, row.contentType, row.name);
  }

  async list(input: ListStagedAttachmentsInput): Promise<StagedAttachment[]> {
    const entries = [...this.rows.values()]
      .filter((row) => row.actorRef === input.actor.id)
      .filter((row) => input.stagedBefore === undefined || row.createdAt < input.stagedBefore)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(({ mediaId, name, contentType, sizeBytes, createdAt }) => ({
        mediaId,
        name,
        contentType,
        sizeBytes,
        createdAt,
      }));
    return input.limit === undefined ? entries : entries.slice(0, input.limit);
  }

  /** What a host's sweep does to the bytes once it has been told they are unreferenced. */
  async delete(mediaId: string): Promise<void> {
    this.rows.delete(mediaId);
  }

  /** Test helper: the bytes still held for `mediaId`, or undefined once collected. */
  bytes(mediaId: string): Buffer | undefined {
    return this.rows.get(mediaId)?.data;
  }

  private toAttachment(mediaId: string, contentType: string, name: string): MessageAttachment {
    return { mediaId, url: this.urlFor(mediaId), contentType, name };
  }
}
