import type { EmbeddingProvider } from '@dudousxd/nestjs-agent-core';

export interface FakeEmbeddingOptions {
  /** Vector width. Default 64 — small but enough for word-overlap to separate passages in tests. */
  dimensions?: number;
  /**
   * How text splits into tokens. `ascii` (default) keeps `[a-z0-9]+` runs, so accented or non-Latin
   * words fall apart; `unicode` keeps runs of any letter or digit (`\p{L}\p{N}`), so "coração" and
   * "東京" are one token each.
   */
  tokens?: 'ascii' | 'unicode';
}

/**
 * A deterministic, offline {@link EmbeddingProvider} for tests: a bag-of-words hash into a fixed-width
 * vector, L2-normalized. No API, no randomness — and because shared words land in the same buckets,
 * cosine similarity tracks word overlap, so a query ranks the passage it shares terms with first.
 */
export class FakeEmbeddingProvider implements EmbeddingProvider {
  private readonly dimensions: number;
  private readonly tokenPattern: RegExp;

  constructor(options: FakeEmbeddingOptions = {}) {
    this.dimensions = options.dimensions ?? 64;
    this.tokenPattern = options.tokens === 'unicode' ? /[\p{L}\p{N}]+/gu : /[a-z0-9]+/g;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => this.embedOne(text));
  }

  private embedOne(text: string): number[] {
    const vector = new Array<number>(this.dimensions).fill(0);
    for (const token of text.toLowerCase().match(this.tokenPattern) ?? []) {
      const bucket = hashToken(token) % this.dimensions;
      vector[bucket] = (vector[bucket] ?? 0) + 1;
    }
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
    return vector.map((value) => value / norm);
  }
}

/**
 * A deterministic hashed bag-of-words {@link EmbeddingProvider} — {@link FakeEmbeddingProvider} with
 * Unicode tokens, as a factory. No model and no network: similar *wording* ranks close, meaning does
 * not. It exists so a test (or a "no embedding model configured" dev mode) can run the whole ingest →
 * embed → retrieve path offline. Same text, same vector, on every machine.
 *
 * ```ts
 * const embedder = hashedEmbeddings(256);
 * ```
 */
export function hashedEmbeddings(dimensions = 64): EmbeddingProvider {
  return new FakeEmbeddingProvider({ dimensions, tokens: 'unicode' });
}

/** FNV-1a over the token's char codes → an unsigned 32-bit bucket index. */
function hashToken(token: string): number {
  let hash = 2166136261;
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
