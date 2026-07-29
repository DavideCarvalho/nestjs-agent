import type { Passage } from '@dudousxd/nestjs-agent-core';
import { matchesFilter } from './filter.js';
import { type MetadataPatch, applyMetadataPatch, isEmptyMetadataPatch } from './metadata-patch.js';
import {
  type IndexedDocument,
  type VectorRecord,
  type VectorSearchOptions,
  type VectorStore,
  documentIdOf,
} from './vector-store.js';

/**
 * An in-process {@link VectorStore} — cosine similarity over a Map, no infra. The reference adapter
 * for tests and small/embedded corpora; for production scale use `PgVectorStore` (or your own).
 */
export class MemoryVectorStore implements VectorStore {
  private readonly records = new Map<string, VectorRecord>();

  async upsert(records: VectorRecord[]): Promise<void> {
    for (const record of records) {
      this.records.set(record.id, record);
    }
  }

  async remove(documentId: string): Promise<void> {
    for (const id of this.records.keys()) {
      if (documentIdOf(id) === documentId) {
        this.records.delete(id);
      }
    }
  }

  /**
   * Merge `patch` into every chunk of `documentId`, leaving `text` and `embedding` untouched. The
   * record is *replaced* rather than mutated: `upsert` stores the caller's own object, and patching
   * it in place would edit an object the caller still holds — a surprise no out-of-process store
   * could reproduce, and therefore one this reference adapter must not teach.
   */
  async updateMetadata(documentId: string, patch: MetadataPatch): Promise<number> {
    if (isEmptyMetadataPatch(patch)) {
      return 0;
    }
    let updated = 0;
    for (const [id, record] of this.records) {
      if (documentIdOf(id) !== documentId) {
        continue;
      }
      this.records.set(id, { ...record, metadata: applyMetadataPatch(record.metadata, patch) });
      updated += 1;
    }
    return updated;
  }

  async listDocuments(filter?: Record<string, unknown>): Promise<IndexedDocument[]> {
    const documents = new Map<string, IndexedDocument>();
    for (const record of this.records.values()) {
      if (filter !== undefined && !matchesFilter(record.metadata, filter)) {
        continue;
      }
      const id = documentIdOf(record.id);
      if (!documents.has(id)) {
        documents.set(id, {
          id,
          ...(record.metadata !== undefined ? { metadata: record.metadata } : {}),
        });
      }
    }
    return [...documents.values()];
  }

  async search(embedding: number[], options: VectorSearchOptions): Promise<Passage[]> {
    const scored: Passage[] = [];
    for (const record of this.records.values()) {
      if (options.filter !== undefined && !matchesFilter(record.metadata, options.filter)) {
        continue;
      }
      scored.push({
        id: record.id,
        text: record.text,
        score: cosineSimilarity(embedding, record.embedding),
        ...(record.source !== undefined ? { source: record.source } : {}),
        ...(record.metadata !== undefined ? { metadata: record.metadata } : {}),
      });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, options.topK);
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const valueA = a[index] ?? 0;
    const valueB = b[index] ?? 0;
    dot += valueA * valueB;
    normA += valueA * valueA;
    normB += valueB * valueB;
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dot / denominator;
}
