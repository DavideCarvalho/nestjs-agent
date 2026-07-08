import type { Passage } from '@dudousxd/nestjs-agent-core';
import { matchesFilter } from './filter.js';
import type { VectorRecord, VectorSearchOptions, VectorStore } from './vector-store.js';

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
    const chunkPrefix = `${documentId}#`;
    for (const id of this.records.keys()) {
      if (id === documentId || id.startsWith(chunkPrefix)) {
        this.records.delete(id);
      }
    }
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
