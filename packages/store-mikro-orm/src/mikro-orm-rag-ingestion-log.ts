import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { type EntityData, EntityManager } from '@mikro-orm/core';
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { RagIngestionLog, type RagIngestionStatus } from './entities/rag-ingestion-log.entity';

/**
 * The `aviary:rag:*` payloads this recorder reads, re-declared here so it couples to the *wire
 * contract* of the diagnostics channel rather than importing `@dudousxd/nestjs-agent-rag-media` —
 * the same convention that package uses for the media channels it consumes. Keep in sync with
 * `rag-media`'s `diagnostics.ts`.
 */
interface RagOutcomePayload {
  mediaId?: unknown;
  ownerType?: unknown;
  ownerId?: unknown;
  collection?: unknown;
  source?: unknown;
  mimeType?: unknown;
  size?: unknown;
  chunks?: unknown;
  reason?: unknown;
  error?: unknown;
}

const CHANNELS: { name: string; status: RagIngestionStatus }[] = [
  { name: 'aviary:rag:media.ingested', status: 'ingested' },
  { name: 'aviary:rag:media.skipped', status: 'skipped' },
  { name: 'aviary:rag:media.failed', status: 'failed' },
  { name: 'aviary:rag:media.removed', status: 'removed' },
];

/** Narrow an unknown payload field to a string, treating everything else as absent. */
function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export interface RagIngestionLogQuery {
  collection?: string;
  status?: RagIngestionStatus;
  limit?: number;
  offset?: number;
}

/**
 * Records the outcome of every RAG ingestion into `rag_ingestion_log`, by subscribing to the
 * `aviary:rag:*` diagnostics channels `@dudousxd/nestjs-agent-rag-media` publishes.
 *
 * It answers the question a vector store structurally cannot: *which documents failed to index, and
 * why*. A skipped or failed document produces no chunks, so it is invisible to
 * `VectorStore.listDocuments()` — the index only knows about successes. Pair the two for a complete
 * picture: the store is the truth about what is retrievable, this table is the truth about what was
 * attempted.
 *
 * Writes are best-effort and never throw: this runs detached from any request, on a diagnostics
 * channel, so a failed write must not take down the ingestion that triggered it. A lost row costs
 * observability, not data — the vector store remains the system of record.
 */
@Injectable()
export class MikroOrmRagIngestionLog implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MikroOrmRagIngestionLog.name);
  private teardowns: (() => void)[] = [];
  private readonly inFlight = new Set<Promise<void>>();

  constructor(private readonly em: EntityManager) {}

  onModuleInit(): void {
    for (const channel of CHANNELS) {
      const listener = (message: unknown): void => {
        const payload = (message as { payload?: RagOutcomePayload })?.payload;
        if (payload !== undefined) {
          this.track(this.record(channel.status, payload));
        }
      };
      subscribe(channel.name, listener);
      this.teardowns.push(() => unsubscribe(channel.name, listener));
    }
  }

  async onModuleDestroy(): Promise<void> {
    for (const teardown of this.teardowns) {
      teardown();
    }
    this.teardowns = [];
    await this.settle();
  }

  /** Await every in-flight write — for graceful shutdown and deterministic tests. */
  async settle(): Promise<void> {
    await Promise.allSettled([...this.inFlight]);
  }

  /** The latest recorded outcome per document, newest first. */
  async list(query: RagIngestionLogQuery = {}): Promise<RagIngestionLog[]> {
    return this.em.fork().find(RagIngestionLog, this.where(query), {
      orderBy: { updatedAt: 'desc' },
      limit: query.limit ?? 200,
      ...(query.offset !== undefined ? { offset: query.offset } : {}),
    });
  }

  /**
   * The same page plus the unpaginated total, so a caller can tell "these are all of them" from
   * "these are the first N". A list that silently truncates reads as complete when it isn't.
   */
  async listPage(
    query: RagIngestionLogQuery = {},
  ): Promise<{ rows: RagIngestionLog[]; total: number }> {
    const em = this.em.fork();
    const [rows, total] = await em.findAndCount(RagIngestionLog, this.where(query), {
      orderBy: { updatedAt: 'desc' },
      limit: query.limit ?? 200,
      ...(query.offset !== undefined ? { offset: query.offset } : {}),
    });
    return { rows, total };
  }

  /** The latest recorded outcome for one document, or null if it was never attempted. */
  async get(documentId: string): Promise<RagIngestionLog | null> {
    return this.em.fork().findOne(RagIngestionLog, { documentId });
  }

  /** Forget one document's record. Returns whether a row was actually removed. */
  async remove(documentId: string): Promise<boolean> {
    const deleted = await this.em.fork().nativeDelete(RagIngestionLog, { documentId });
    return deleted > 0;
  }

  /** Forget every record for a collection — for when the collection itself is deleted. */
  async removeByCollection(collection: string): Promise<number> {
    return this.em.fork().nativeDelete(RagIngestionLog, { collection });
  }

  private where(query: RagIngestionLogQuery): Record<string, unknown> {
    return {
      ...(query.collection !== undefined ? { collection: query.collection } : {}),
      ...(query.status !== undefined ? { status: query.status } : {}),
    };
  }

  /**
   * Upsert one outcome. Keyed by document id so the row always reflects the *current* state — a
   * retry that succeeds overwrites the failure it replaces, rather than leaving a stale error next
   * to a working document.
   */
  private async record(status: RagIngestionStatus, payload: RagOutcomePayload): Promise<void> {
    const documentId = str(payload.mediaId);
    if (documentId === null) {
      return;
    }
    try {
      // forked EM: this runs outside any request, so it must not touch the shared context.
      const em = this.em.fork();
      const now = new Date();
      // Only include coordinates the payload actually carries. An omitted field is left out of the
      // conflict-merge set, so `em.upsert` leaves it untouched on update — a sparser later event
      // (e.g. `removed`, which knows the owner but not the collection) can't blank out what an
      // earlier `ingested` recorded.
      const collection = str(payload.collection);
      const ownerType = str(payload.ownerType);
      const ownerId = str(payload.ownerId);
      const source = str(payload.source);
      const mimeType = str(payload.mimeType);
      const size = num(payload.size);
      const data: EntityData<RagIngestionLog> = {
        documentId,
        status,
        // The three outcome-specific columns are exclusive: null out the ones this status doesn't
        // own on every write, so a successful retry clears the previous attempt's error rather than
        // leaving it next to a working document. Always present → always in the merge set.
        chunks: status === 'ingested' ? num(payload.chunks) : null,
        reason: status === 'skipped' ? str(payload.reason) : null,
        error: status === 'failed' ? str(payload.error) : null,
        createdAt: now,
        updatedAt: now,
        ...(collection !== null ? { collection } : {}),
        ...(ownerType !== null ? { ownerType } : {}),
        ...(ownerId !== null ? { ownerId } : {}),
        ...(source !== null ? { source } : {}),
        ...(mimeType !== null ? { mimeType } : {}),
        ...(size !== null ? { size } : {}),
      };
      // Atomic insert-or-update keyed by the document id (the PK). Two concurrent events for the same
      // NEW document can't race to a duplicate-key insert the way find-then-insert did. `createdAt`
      // is set on insert but excluded from the merge, so an update never overwrites it.
      await em.upsert(RagIngestionLog, data, { onConflictExcludeFields: ['createdAt'] });
    } catch (error) {
      this.logger.warn(
        `Could not record RAG ingestion outcome for ${documentId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private track(promise: Promise<void>): void {
    const tracked = promise.finally(() => {
      this.inFlight.delete(tracked);
    });
    this.inFlight.add(tracked);
  }
}
