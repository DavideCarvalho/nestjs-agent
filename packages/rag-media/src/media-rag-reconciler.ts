import type { MediaAttachEvent } from './media-events.js';
import { type MediaIngestionDeps, ingestMediaFile, removeMedia } from './media-ingestion.js';

/** Identifies one owner's collection to reconcile. */
export interface ReconcileQuery {
  ownerType: string;
  ownerId: string;
  collection: string;
}

/**
 * The source of truth: the media records currently attached to an owner's collection. Wire it from
 * the media library — e.g. map `mediaLibrary.for(ownerType, ownerId).list(collection)` to
 * {@link MediaAttachEvent}s.
 */
export interface MediaSource {
  listMedia(query: ReconcileQuery): Promise<MediaAttachEvent[]>;
}

export interface MediaRagReconcilerDeps extends MediaIngestionDeps {
  source: MediaSource;
}

export interface ReconcileResult {
  /** Document ids ingested because they were in media but missing from the index. */
  ingested: string[];
  /** Document ids re-ingested because the indexed `size` fingerprint no longer matched media. */
  reingested: string[];
  /** Document ids removed because they were indexed but no longer in media (orphans). */
  removed: string[];
}

/**
 * Reconcile the vector store against the media source of truth for one owner/collection: ingest media
 * that isn't indexed yet, re-ingest media whose content changed (the indexed `size` fingerprint no
 * longer matches), and remove indexed documents whose media record is gone. Repairs drift the event
 * stream can miss — a subscriber that was down, a record deleted straight in the DB, or a file
 * replaced while nobody was listening. Safe to run on a schedule or at boot; it only touches the
 * difference.
 */
export async function reconcileMediaRag(
  query: ReconcileQuery,
  deps: MediaRagReconcilerDeps,
): Promise<ReconcileResult> {
  const media = await deps.source.listMedia(query);
  const mediaIds = new Set(media.map((event) => event.id));
  const indexed = await deps.store.listDocuments({
    ownerType: query.ownerType,
    ownerId: query.ownerId,
    collection: query.collection,
  });
  const indexedById = new Map(indexed.map((document) => [document.id, document]));

  const removed: string[] = [];
  for (const document of indexed) {
    if (!mediaIds.has(document.id)) {
      await removeMedia(
        { id: document.id, ownerType: query.ownerType, ownerId: query.ownerId },
        { store: deps.store },
      );
      removed.push(document.id);
    }
  }

  const ingested: string[] = [];
  const reingested: string[] = [];
  for (const event of media) {
    const existing = indexedById.get(event.id);
    if (existing === undefined) {
      if ((await ingestMediaFile(event, deps)).status === 'ingested') {
        ingested.push(event.id);
      }
    } else if (existing.metadata?.size !== event.size) {
      // content changed under a stable id (or was indexed before size was tracked) → re-ingest.
      if ((await ingestMediaFile(event, deps)).status === 'ingested') {
        reingested.push(event.id);
      }
    }
  }

  return { ingested, reingested, removed };
}
