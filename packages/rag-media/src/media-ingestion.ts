import type { EmbeddingProvider } from '@dudousxd/nestjs-agent-core';
import {
  type ChunkOptions,
  type VectorStore,
  chunkDocuments,
  ingestChunks,
} from '@dudousxd/nestjs-agent-rag';
import {
  publishRagMediaIngested,
  publishRagMediaRemoved,
  publishRagMediaSkipped,
} from './diagnostics.js';
import type { MediaAttachEvent, MediaDeleteEvent } from './media-events.js';
import { type TextExtractor, UnsupportedMimeTypeError } from './text-extractor.js';

/** Read a media file's bytes from its disk. Host wires `(disk, path) => media.disk(disk).get(path)`. */
export type ReadFile = (disk: string, path: string) => Promise<Buffer>;

/** Default upper bound on a file we'll read into memory to ingest — 25 MB. */
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

export interface MediaIngestionDeps {
  readFile: ReadFile;
  embedder: EmbeddingProvider;
  store: VectorStore;
  extractor: TextExtractor;
  /** Chunking options forwarded to `chunkDocuments`. */
  chunk?: ChunkOptions;
  /** Skip (don't read) files larger than this many bytes. Default 25 MB. */
  maxBytes?: number;
}

export type MediaIngestSkipReason = 'unsupported-type' | 'too-large' | 'empty-text';

export type MediaIngestResult =
  | { status: 'ingested'; chunks: number }
  | { status: 'skipped'; reason: MediaIngestSkipReason };

/**
 * Ingest one attached media file into a vector store: size-gate → read bytes → extract text →
 * `store.remove(id)` (orphan-free re-attach) → chunk → embed → upsert. Chunk metadata carries the
 * owner (`ownerType`/`ownerId`) and `collection` from the server-side attach record, so retrieval can
 * be scoped per user/tenant via {@link import('@dudousxd/nestjs-agent-rag').FilteredRetriever}.
 *
 * Exposed as a pure function so a host can run it inside a durable workflow if it wants; the
 * {@link import('./media-ingestion.module.js').AgentMediaIngestionModule module} runs it inline.
 * Unsupported mime types and empty/oversized files are skipped (not errors).
 */
export async function ingestMediaFile(
  event: MediaAttachEvent,
  deps: MediaIngestionDeps,
): Promise<MediaIngestResult> {
  const maxBytes = deps.maxBytes ?? DEFAULT_MAX_BYTES;
  if (event.size > maxBytes) {
    publishRagMediaSkipped({ mediaId: event.id, mimeType: event.mimeType, reason: 'too-large' });
    return { status: 'skipped', reason: 'too-large' };
  }

  let text: string;
  try {
    const bytes = await deps.readFile(event.disk, event.path);
    text = await deps.extractor.extract(bytes, event.mimeType);
  } catch (error) {
    if (error instanceof UnsupportedMimeTypeError) {
      publishRagMediaSkipped({
        mediaId: event.id,
        mimeType: event.mimeType,
        reason: 'unsupported-type',
      });
      return { status: 'skipped', reason: 'unsupported-type' };
    }
    throw error;
  }

  if (text.trim() === '') {
    publishRagMediaSkipped({ mediaId: event.id, mimeType: event.mimeType, reason: 'empty-text' });
    return { status: 'skipped', reason: 'empty-text' };
  }

  // remove-then-ingest so a re-attach that shrinks to fewer chunks doesn't leave a stale tail.
  await deps.store.remove(event.id);
  const chunks = chunkDocuments(
    [
      {
        id: event.id,
        text,
        source: event.path,
        metadata: {
          mediaId: event.id,
          ownerType: event.ownerType,
          ownerId: event.ownerId,
          collection: event.collection,
        },
      },
    ],
    deps.chunk ?? {},
  );
  const count = await ingestChunks(chunks, { embedder: deps.embedder, store: deps.store });
  publishRagMediaIngested({
    mediaId: event.id,
    ownerType: event.ownerType,
    ownerId: event.ownerId,
    collection: event.collection,
    chunks: count,
  });
  return { status: 'ingested', chunks: count };
}

/** Drop a deleted media record's chunks from the vector store — the delete-sync half. */
export async function removeMedia(
  event: MediaDeleteEvent,
  deps: { store: VectorStore },
): Promise<void> {
  await deps.store.remove(event.id);
  publishRagMediaRemoved({
    mediaId: event.id,
    ownerType: event.ownerType,
    ownerId: event.ownerId,
  });
}
