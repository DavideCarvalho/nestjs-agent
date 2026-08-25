import { EntityRepository, EntityRepositoryType, EntitySchema } from '@mikro-orm/core';

/** The terminal states an ingestion attempt can land in. Mirrors `MediaIngestOutcome`. */
export type RagIngestionStatus = 'ingested' | 'skipped' | 'failed' | 'removed';

/**
 * The latest ingestion outcome for one RAG document — one row per document id, overwritten on
 * re-ingest.
 *
 * This exists because the vector store can only enumerate what it *has*: a document whose extraction
 * produced no text, whose mime type had no extractor, or whose embedding call blew up has zero chunks
 * and is therefore invisible to `VectorStore.listDocuments()`. Without this table, a scanned PDF that
 * silently failed to index is indistinguishable from one that was never uploaded.
 *
 * `collection` / `ownerType` / `ownerId` are opaque strings copied off the diagnostics payload — this
 * package never interprets them, and deliberately has no foreign key to a host's own collection
 * table, which it cannot know about.
 */
export class RagIngestionLog {
  /** The vector-store document id (chunk ids are `${documentId}#<n>`). */
  documentId!: string;
  status!: RagIngestionStatus;
  collection?: string | null;
  ownerType?: string | null;
  ownerId?: string | null;
  /** Citation-facing origin — the media record's path. */
  source?: string | null;
  mimeType?: string | null;
  size?: number | null;
  /** Chunk count on `ingested`; null otherwise. */
  chunks?: number | null;
  /** Skip reason on `skipped` (`unsupported-type` | `too-large` | `empty-text`); null otherwise. */
  reason?: string | null;
  /** Error message on `failed`; null otherwise. */
  error?: string | null;
  createdAt!: Date;
  updatedAt!: Date;
  [EntityRepositoryType]?: RagIngestionLogRepository;
}

/** Custom repository for {@link RagIngestionLog}, so a host can inject it by type instead of passing the entity to every `em` call. */
export class RagIngestionLogRepository extends EntityRepository<RagIngestionLog> {}

/** Builds the `rag_ingestion_log` schema. Indexed by collection for the per-collection listing. */
export function ragIngestionLogSchema(collation?: string): EntitySchema<RagIngestionLog> {
  const str = collation !== undefined ? { collation } : {};
  return new EntitySchema<RagIngestionLog>({
    class: RagIngestionLog,
    tableName: 'rag_ingestion_log',
    repository: () => RagIngestionLogRepository,
    indexes: [
      { name: 'rag_ingestion_log_collection_idx', properties: ['collection', 'updatedAt'] },
    ],
    properties: {
      documentId: { type: 'string', primary: true, fieldName: 'document_id', ...str },
      status: { type: 'string', ...str },
      collection: { type: 'string', nullable: true, ...str },
      ownerType: { type: 'string', nullable: true, fieldName: 'owner_type', ...str },
      ownerId: { type: 'string', nullable: true, fieldName: 'owner_id', ...str },
      source: { type: 'string', nullable: true, ...str },
      mimeType: { type: 'string', nullable: true, fieldName: 'mime_type', ...str },
      size: { type: 'integer', nullable: true },
      chunks: { type: 'integer', nullable: true },
      reason: { type: 'string', nullable: true, ...str },
      error: { type: 'text', nullable: true },
      createdAt: { type: 'datetime', fieldName: 'created_at' },
      updatedAt: { type: 'datetime', fieldName: 'updated_at' },
    },
  });
}
