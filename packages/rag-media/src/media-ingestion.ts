import type { EmbeddingProvider } from '@dudousxd/nestjs-agent-core';
import {
  type ChunkOptions,
  type VectorStore,
  chunkDocuments,
  ingestChunks,
} from '@dudousxd/nestjs-agent-rag';
import {
  outcomeContext,
  publishRagMediaIngested,
  publishRagMediaRemoved,
  publishRagMediaSkipped,
} from './diagnostics.js';
import type { MediaAttachEvent, MediaDeleteEvent } from './media-events.js';
import {
  type TextExtractor,
  UnsupportedMimeTypeError,
  defaultTextExtractor,
} from './text-extractor.js';

/** Read a media file's bytes from its disk. Host wires `(disk, path) => media.disk(disk).get(path)`. */
export type ReadFile = (disk: string, path: string) => Promise<Buffer>;

/**
 * Ask the STORAGE layer how big a file really is, without reading it. Host wires
 * `(disk, path) => media.disk(disk).size(path)` (S3 `HeadObject`, `fs.stat`, …).
 */
export type StatFile = (disk: string, path: string) => Promise<number>;

/** Default upper bound on a file we'll read into memory to ingest — 25 MB. */
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

/**
 * Everything ingestion needs. The one config shape — {@link AgentMediaIngestionOptions} extends it,
 * so the same object drives the module and a durable worker (no drift between them). Optionals are
 * defaulted at the point of use, so a caller only ever supplies `readFile` / `embedder` / `store`.
 */
export interface MediaIngestionDeps {
  readFile: ReadFile;
  embedder: EmbeddingProvider;
  store: VectorStore;
  /** Bytes → text. Default {@link defaultTextExtractor} (text/*, JSON, HTML). */
  extractor?: TextExtractor;
  /** Chunking options forwarded to `chunkDocuments`. */
  chunk?: ChunkOptions;
  /**
   * Optional storage-side size probe, consulted before `readFile`. `MediaAttachEvent.size` is a
   * DECLARED value — in most hosts it originates in the upload session the client opened, so it can
   * be wrong (or adversarially `0`). The real byte length is always re-checked after the read, but
   * that means a lying `size` still costs one full download; wiring `statFile` (S3 `HeadObject`,
   * `fs.stat`) moves the authoritative check ahead of it so an oversized object is never fetched.
   */
  statFile?: StatFile;
  /** Skip files larger than this many bytes. Default 25 MB. */
  maxBytes?: number;
  /**
   * Extra metadata stamped on every chunk, merged OVER the defaults (`mediaId`, `ownerType`,
   * `ownerId`, `collection`, `size`) so a host can add its own keys or override a default one.
   * Opaque to this package — whatever you return is handed to the vector store as-is.
   *
   * This is the seam for host-defined retrieval scoping. A capability-token ACL, for example, stamps
   * the tokens that gate the document and filters on them at query time, without this package ever
   * knowing what a token means:
   *
   * ```ts
   * metadata: (event) => ({ collectionId: event.collection, audience: tokensFor(event) })
   * ```
   */
  metadata?: (event: MediaAttachEvent) => Record<string, unknown>;
}

export type MediaIngestSkipReason = 'unsupported-type' | 'too-large' | 'empty-text';

export type MediaIngestResult =
  | { status: 'ingested'; chunks: number }
  | { status: 'skipped'; reason: MediaIngestSkipReason };

/**
 * Ingest one attached media file into a vector store: size-gate → read bytes → re-check the REAL
 * size → extract text → `store.remove(id)` (orphan-free re-attach) → chunk → embed → upsert.
 *
 * The size gate never trusts `event.size` alone. That number is declared upstream (typically by the
 * client that opened the upload session), so a file announced as `0` would otherwise sail past the
 * limit into an embedding batch, and every chunk would then carry `size: 0` — poisoning the very
 * fingerprint {@link import('./media-rag-reconciler.js').reconcileMediaRag} compares against media.
 * The declared value is therefore only ever allowed to REJECT early (a cheap short-circuit); what
 * authorizes the ingest, and what gets stamped into chunk metadata, is the real byte length.
 *
 * Chunk metadata carries the
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
  const skipTooLarge = (): MediaIngestResult => {
    publishRagMediaSkipped({
      ...outcomeContext(event),
      mimeType: event.mimeType,
      reason: 'too-large',
    });
    return { status: 'skipped', reason: 'too-large' };
  };

  // Fast path only: a declared size over the limit is taken at its word (nothing is gained by
  // downloading a file its own record admits is too big), but a declared size UNDER it proves nothing.
  if (event.size > maxBytes) {
    return skipTooLarge();
  }
  if (deps.statFile !== undefined && (await deps.statFile(event.disk, event.path)) > maxBytes) {
    return skipTooLarge();
  }

  const extractor = deps.extractor ?? defaultTextExtractor();
  let size: number;
  let text: string;
  try {
    const bytes = await deps.readFile(event.disk, event.path);
    // Authoritative gate: the bytes we actually hold. Guards the expensive half (extract → embed)
    // against a lying declaration when no `statFile` is wired.
    if (bytes.byteLength > maxBytes) {
      return skipTooLarge();
    }
    size = bytes.byteLength;
    text = await extractor.extract(bytes, event.mimeType);
  } catch (error) {
    if (error instanceof UnsupportedMimeTypeError) {
      publishRagMediaSkipped({
        ...outcomeContext(event),
        mimeType: event.mimeType,
        reason: 'unsupported-type',
      });
      return { status: 'skipped', reason: 'unsupported-type' };
    }
    throw error;
  }

  if (text.trim() === '') {
    publishRagMediaSkipped({
      ...outcomeContext(event),
      mimeType: event.mimeType,
      reason: 'empty-text',
    });
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
          // fingerprint the reconciler compares against the live media record to catch a content
          // change a missed attach event would otherwise leave stale. The REAL byte length, not the
          // declared one — a fingerprint copied from an untrusted claim can never detect drift.
          size,
          // Host-supplied keys win, so a caller can add retrieval-scoping metadata (or correct a
          // default) without this package knowing what any of it means.
          ...deps.metadata?.(event),
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
    source: event.path,
    size,
    mimeType: event.mimeType,
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
