import type { Passage, RetrieveOptions, Retriever } from '@dudousxd/nestjs-agent-core';
import { matchesFilter } from './filter.js';
import type { ChunkRecord } from './ingest.js';
import { documentIdOf } from './vector-store.js';

export interface KeywordRetrieverOptions {
  /** BM25 term-frequency saturation. Default 1.5. */
  k1?: number;
  /** BM25 length normalization, 0 (off) … 1 (full). Default 0.75. */
  b?: number;
}

interface IndexedDoc {
  record: ChunkRecord;
  /** term → frequency within this doc. */
  frequencies: Map<string, number>;
  length: number;
}

/**
 * An in-memory BM25 lexical retriever — the keyword half of hybrid search. Feed it the SAME
 * {@link ChunkRecord}s you upsert into the vector store (from `chunkDocuments`) so their chunk ids
 * line up and `HybridRetriever` can fuse the two rankings. Full BM25: idf, term-frequency saturation
 * (`k1`), and document-length normalization (`b`).
 *
 * Because it holds its OWN copy of each chunk's text, it needs the same delete-sync as the vector
 * store: whenever you call {@link import('./vector-store.js').VectorStore.remove}, call
 * {@link KeywordRetriever.remove} with the same document id. Skipping it leaves the document
 * lexically retrievable — `retrieve` would keep returning the removed passage's full text.
 */
export class KeywordRetriever implements Retriever {
  private readonly docs = new Map<string, IndexedDoc>();
  private readonly documentFrequency = new Map<string, number>();
  private totalLength = 0;
  private readonly k1: number;
  private readonly b: number;

  constructor(options: KeywordRetrieverOptions = {}) {
    this.k1 = options.k1 ?? 1.5;
    this.b = options.b ?? 0.75;
  }

  /** How many chunks are currently indexed. */
  get size(): number {
    return this.docs.size;
  }

  /** Index (or re-index) records. Re-adding an existing id replaces its posting and updates stats. */
  add(records: ChunkRecord[]): void {
    for (const record of records) {
      this.removeChunk(record.id);
      const tokens = tokenize(record.text);
      const frequencies = new Map<string, number>();
      for (const token of tokens) {
        frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
      }
      for (const term of frequencies.keys()) {
        this.documentFrequency.set(term, (this.documentFrequency.get(term) ?? 0) + 1);
      }
      this.docs.set(record.id, { record, frequencies, length: tokens.length });
      this.totalLength += tokens.length;
    }
  }

  /**
   * Forget a source document — every chunk whose id is `${documentId}` or `${documentId}#<n>`, the
   * same id scheme (and the same {@link documentIdOf} collapse) the vector stores use for their
   * `remove`. The keyword half of a hybrid index keeps its own copy of the chunk text, so a document
   * dropped from the vector store stays fully retrievable here until this is called. Unknown ids are
   * a no-op.
   */
  remove(documentId: string): void {
    for (const id of [...this.docs.keys()]) {
      if (id === documentId || documentIdOf(id) === documentId) {
        this.removeChunk(id);
      }
    }
  }

  /** Drop every indexed chunk, resetting the corpus statistics with it. */
  clear(): void {
    this.docs.clear();
    this.documentFrequency.clear();
    this.totalLength = 0;
  }

  /** Drop ONE chunk by its exact id, decrementing the corpus statistics it contributed. */
  private removeChunk(id: string): void {
    const existing = this.docs.get(id);
    if (existing === undefined) {
      return;
    }
    for (const term of existing.frequencies.keys()) {
      const next = (this.documentFrequency.get(term) ?? 1) - 1;
      if (next <= 0) {
        this.documentFrequency.delete(term);
      } else {
        this.documentFrequency.set(term, next);
      }
    }
    this.totalLength -= existing.length;
    this.docs.delete(id);
  }

  async retrieve(query: string, options: RetrieveOptions = {}): Promise<Passage[]> {
    const total = this.docs.size;
    if (total === 0) {
      return [];
    }
    const averageLength = this.totalLength / total;
    const queryTerms = new Set(tokenize(query));
    const scored: Passage[] = [];
    for (const { record, frequencies, length } of this.docs.values()) {
      if (options.filter !== undefined && !matchesFilter(record.metadata, options.filter)) {
        continue;
      }
      let score = 0;
      for (const term of queryTerms) {
        const termFrequency = frequencies.get(term);
        if (termFrequency === undefined) {
          continue;
        }
        const df = this.documentFrequency.get(term) ?? 0;
        const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5));
        const denominator =
          termFrequency + this.k1 * (1 - this.b + (this.b * length) / averageLength);
        score += idf * ((termFrequency * (this.k1 + 1)) / denominator);
      }
      if (score > 0) {
        scored.push({
          id: record.id,
          text: record.text,
          score,
          ...(record.source !== undefined ? { source: record.source } : {}),
          ...(record.metadata !== undefined ? { metadata: record.metadata } : {}),
        });
      }
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, options.topK ?? 5);
  }
}

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}
