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
  /** Document ids removed because they were indexed but no longer in media (orphans). */
  removed: string[];
}

/**
 * Reconcile the vector store against the media source of truth for one owner/collection: ingest media
 * that isn't indexed yet, and remove indexed documents whose media record is gone. Repairs drift the
 * event stream can miss — a subscriber that was down, or a record deleted straight in the DB. Safe to
 * run on a schedule or at boot; it only touches the difference.
 */
export async function reconcileMediaRag(
  query: ReconcileQuery,
  deps: MediaRagReconcilerDeps,
): Promise<ReconcileResult> {
  const media = await deps.source.listMedia(query);
  const mediaIds = new Set(media.map((event) => event.id));
  const indexed = new Set(
    await deps.store.listDocumentIds({
      ownerType: query.ownerType,
      ownerId: query.ownerId,
      collection: query.collection,
    }),
  );

  const removed: string[] = [];
  for (const documentId of indexed) {
    if (!mediaIds.has(documentId)) {
      await removeMedia(
        { id: documentId, ownerType: query.ownerType, ownerId: query.ownerId },
        { store: deps.store },
      );
      removed.push(documentId);
    }
  }

  const ingested: string[] = [];
  for (const event of media) {
    if (!indexed.has(event.id)) {
      const result = await ingestMediaFile(event, deps);
      if (result.status === 'ingested') {
        ingested.push(event.id);
      }
    }
  }

  return { ingested, removed };
}
