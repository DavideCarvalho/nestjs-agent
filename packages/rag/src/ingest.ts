import type { EmbeddingProvider } from '@dudousxd/nestjs-agent-core';
import { type ChunkOptions, chunkText } from './chunk.js';
import type { VectorRecord, VectorStore } from './vector-store.js';

/** A source document to ingest. `id` scopes the chunk ids (`${id}#${n}`); `source` is the citation. */
export interface IngestDocument {
  id: string;
  text: string;
  source?: string;
  metadata?: Record<string, unknown>;
}

export interface IngestOptions extends ChunkOptions {
  embedder: EmbeddingProvider;
  store: VectorStore;
}

/**
 * Chunk → embed (one batched `embed` call) → upsert. Returns how many chunk records were written.
 * Chunk ids are `${doc.id}#${index}`, so re-ingesting a document overwrites its chunks in place
 * (deterministic ids, upsert semantics) rather than duplicating them.
 */
export async function ingestDocuments(
  documents: IngestDocument[],
  options: IngestOptions,
): Promise<number> {
  const chunks: Omit<VectorRecord, 'embedding'>[] = [];
  for (const document of documents) {
    chunkText(document.text, options).forEach((text, index) => {
      chunks.push({
        id: `${document.id}#${index}`,
        text,
        ...(document.source !== undefined ? { source: document.source } : {}),
        ...(document.metadata !== undefined ? { metadata: document.metadata } : {}),
      });
    });
  }
  if (chunks.length === 0) {
    return 0;
  }
  const embeddings = await options.embedder.embed(chunks.map((chunk) => chunk.text));
  const records: VectorRecord[] = chunks.map((chunk, index) => ({
    ...chunk,
    embedding: embeddings[index] ?? [],
  }));
  await options.store.upsert(records);
  return records.length;
}
