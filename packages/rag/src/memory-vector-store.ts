import type { Passage } from '@dudousxd/nestjs-agent-core';
import { filterMatchesNothing, matchesFilter } from './filter.js';
import { type MetadataPatch, applyMetadataPatch, isEmptyMetadataPatch } from './metadata-patch.js';
import {
  type IndexedDocument,
  UnsafeRemovalError,
  type VectorRecord,
  type VectorSearchOptions,
  type VectorStore,
  documentIdOf,
} from './vector-store.js';

/**
 * An in-process {@link VectorStore} — cosine similarity over a Map, no infra. The reference adapter
 * for tests and small/embedded corpora; for production scale use `PgVectorStore` (or your own).
 *
 * It implements the enumeration and bulk-deletion half of {@link VectorStore} too. There is no
 * performance argument for it here — every method below is a loop over the same Map — but a store that tests are
 * written against has to behave identically to the one production runs, and the semantics that matter
 * (`removeWhere` refusing an empty filter, an empty-array filter deleting nothing) are behavioural,
 * not incidental to Redis.
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

  async listDocumentIds(filter?: Record<string, unknown>): Promise<string[]> {
    if (filterMatchesNothing(filter)) {
      return [];
    }
    const documents = new Set<string>();
    for (const record of this.records.values()) {
      if (filter !== undefined && !matchesFilter(record.metadata, filter)) {
        continue;
      }
      documents.add(documentIdOf(record.id));
    }
    return [...documents];
  }

  async removeMany(documentIds: string[]): Promise<void> {
    if (documentIds.length === 0) {
      return;
    }
    const wanted = new Set(documentIds);
    for (const id of this.records.keys()) {
      if (wanted.has(documentIdOf(id))) {
        this.records.delete(id);
      }
    }
  }

  /**
   * See {@link VectorStore.removeWhere}. The empty-array short-circuit below is redundant
   * against `matchesFilter` (which already matches nothing for an empty array) and is kept anyway:
   * this is the method where "the filter accidentally means everything" destroys data, so the deny is
   * stated where a reader can see it rather than inferred from another module's truth table.
   */
  async removeWhere(filter: Record<string, unknown>): Promise<number> {
    if (Object.keys(filter).length === 0) {
      throw new UnsafeRemovalError(
        'empty-filter',
        'removeWhere() refuses an empty filter: it would delete every chunk in the store. ' +
          'Pass a filter that scopes the removal, or delete deliberately with ' +
          'removeMany(await store.listDocumentIds()).',
      );
    }
    if (filterMatchesNothing(filter)) {
      return 0;
    }
    let removed = 0;
    for (const [id, record] of this.records) {
      if (matchesFilter(record.metadata, filter)) {
        this.records.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  async countChunks(filter?: Record<string, unknown>): Promise<number> {
    if (filterMatchesNothing(filter)) {
      return 0;
    }
    let count = 0;
    for (const record of this.records.values()) {
      if (filter === undefined || matchesFilter(record.metadata, filter)) {
        count += 1;
      }
    }
    return count;
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
