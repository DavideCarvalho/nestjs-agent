import { describe, expect, it } from 'vitest';
import { FakeEmbeddingProvider, hashedEmbeddings } from './fake-embedding-provider.js';

const cosine = (a: number[], b: number[]) =>
  a.reduce((sum, value, index) => sum + value * (b[index] ?? 0), 0);

describe('hashedEmbeddings', () => {
  it('is deterministic, normalized and as wide as asked', async () => {
    const [first] = await hashedEmbeddings(32).embed(['Solar panel warranty']);
    const [again] = await hashedEmbeddings(32).embed(['Solar panel warranty']);
    expect(first).toHaveLength(32);
    expect(first).toEqual(again);
    expect(Math.hypot(...(first ?? []))).toBeCloseTo(1);
  });

  it('keeps accented and non-Latin words whole, so they still match themselves', async () => {
    const embedder = hashedEmbeddings(256);
    const [query, same, other] = await embedder.embed(['coração', 'meu coração', 'meu cora']);
    expect(cosine(query ?? [], same ?? [])).toBeGreaterThan(cosine(query ?? [], other ?? []));
    // The ASCII tokenizer splits "coração" into "cora" + "o", so it can't tell those two apart.
    const ascii = new FakeEmbeddingProvider({ dimensions: 256 });
    const [asciiQuery, asciiOther] = await ascii.embed(['coração', 'cora o']);
    expect(asciiQuery).toEqual(asciiOther);
  });

  it('leaves FakeEmbeddingProvider ASCII-tokenized by default', async () => {
    const [plain] = await new FakeEmbeddingProvider().embed(['naïve']);
    const [split] = await new FakeEmbeddingProvider().embed(['na ve']);
    expect(plain).toEqual(split);
  });
});
