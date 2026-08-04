import { describe, expect, it } from 'vitest';
import {
  type RagRetrieval,
  meanChunks,
  percentile,
  readRetrievals,
  toCollectionRows,
  toLatencyDistribution,
  toRagRetrieval,
  toRetrievalTrendRows,
  toRetrieverSegments,
  toScoreDistribution,
  toSlowestRows,
  toStoreSegments,
  zeroHitRate,
} from './rag-data-providers.js';

const AT = new Date('2026-08-04T12:34:00.000Z');

function retrieval(overrides: Partial<RagRetrieval> = {}): RagRetrieval {
  return {
    at: AT,
    retriever: 'embedding',
    store: 'redis',
    collection: 'kb_idx',
    chunks: 3,
    zeroHit: false,
    topScore: 0.42,
    durationMs: 40,
    failed: false,
    ...overrides,
  };
}

describe('toRagRetrieval', () => {
  it('normalizes an entry the watcher recorded', () => {
    const parsed = toRagRetrieval({
      createdAt: AT,
      content: {
        event: 'retrieval',
        retriever: 'hybrid',
        store: 'pg',
        collection: 'agent_rag_chunks',
        topK: 5,
        chunks: 2,
        zeroHit: false,
        topScore: 0.81,
        meanScore: 0.6,
        failed: false,
        durationMs: 120,
      },
    });

    expect(parsed).toEqual({
      at: AT,
      retriever: 'hybrid',
      store: 'pg',
      collection: 'agent_rag_chunks',
      chunks: 2,
      zeroHit: false,
      topScore: 0.81,
      durationMs: 120,
      failed: false,
    });
  });

  it('drops an entry that is not a retrieval, and never invents a number', () => {
    expect(toRagRetrieval(null)).toBeNull();
    expect(toRagRetrieval({ content: { event: 'run.finished' } })).toBeNull();
    // A producer older than the duration field: the field must land as null (excluded from every
    // percentile) rather than as a NaN that poisons whatever aggregate touches it.
    const partial = toRagRetrieval({ createdAt: AT, content: { retriever: 'keyword' } });
    expect(partial?.durationMs).toBeNull();
    expect(partial?.topScore).toBeNull();
    expect(partial?.chunks).toBe(0);
    expect(partial?.zeroHit).toBe(true);
  });
});

describe('readRetrievals', () => {
  it('reads the agent-rag window and skips unparseable rows', async () => {
    const storage = {
      calls: [] as Array<{ type?: string; limit?: number }>,
      async get(query: { type?: string; limit?: number }) {
        this.calls.push(query);
        return { data: [{ createdAt: AT, content: { retriever: 'embedding', chunks: 1 } }, {}] };
      },
    };

    const retrievals = await readRetrievals(storage);

    expect(retrievals).toHaveLength(1);
    expect(storage.calls[0]?.type).toBe('agent-rag');
  });

  it('degrades to empty when the host has no recognisable Telescope storage', async () => {
    expect(await readRetrievals(undefined)).toEqual([]);
    expect(await readRetrievals({ notStorage: true })).toEqual([]);
  });
});

describe('retrieval aggregates', () => {
  it('reports the zero-hit share as a fraction, and 0 over an empty window', () => {
    expect(zeroHitRate([])).toBe(0);
    expect(zeroHitRate([retrieval(), retrieval({ zeroHit: true }), retrieval(), retrieval()])).toBe(
      0.25,
    );
  });

  it('averages passages per retrieval', () => {
    expect(meanChunks([retrieval({ chunks: 5 }), retrieval({ chunks: 0 })])).toBe(2.5);
    expect(meanChunks([])).toBe(0);
  });

  it('takes nearest-rank percentiles', () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([10, 20, 30, 40], 0.5)).toBe(20);
    expect(percentile([10, 20, 30, 40], 0.95)).toBe(40);
  });
});

describe('toLatencyDistribution', () => {
  it('buckets on the fixed ladder and marks p50/p95/p99', () => {
    const distribution = toLatencyDistribution([
      retrieval({ durationMs: 5 }),
      retrieval({ durationMs: 30 }),
      retrieval({ durationMs: 9_000 }),
      retrieval({ durationMs: null }),
    ]);

    expect(distribution.buckets[0]).toEqual({ label: '0–10ms', count: 1 });
    expect(distribution.buckets.find((b) => b.label === '25–50ms')?.count).toBe(1);
    expect(distribution.buckets.at(-1)).toEqual({ label: '≥5000ms', count: 1 });
    expect(distribution.p50).toBe(30);
    expect(distribution.p99).toBe(9_000);
  });

  it('emits the full ladder with no markers when nothing was measured', () => {
    const distribution = toLatencyDistribution([]);
    expect(distribution.buckets).toHaveLength(10);
    expect(distribution.buckets.every((bucket) => bucket.count === 0)).toBe(true);
    expect(distribution.p50).toBeUndefined();
  });
});

describe('toScoreDistribution', () => {
  it('counts only the requested retriever kind — scores share no scale across strategies', () => {
    const distribution = toScoreDistribution(
      [
        retrieval({ retriever: 'embedding', topScore: 0.25 }),
        retrieval({ retriever: 'embedding', topScore: 0.75 }),
        // An RRF score from a hybrid lands in the 0.0–0.1 bin and would read as "quality collapsed".
        retrieval({ retriever: 'hybrid', topScore: 0.016 }),
        // A BM25 score is unbounded and would pin the top bin.
        retrieval({ retriever: 'keyword', topScore: 14.2 }),
      ],
      'embedding',
    );

    expect(distribution.buckets).toHaveLength(10);
    expect(distribution.buckets[2]).toEqual({ label: '0.2–0.3', count: 1 });
    expect(distribution.buckets[7]).toEqual({ label: '0.7–0.8', count: 1 });
    expect(distribution.buckets.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(2);
    expect(distribution.p50).toBe(0.25);
  });

  it('clamps an out-of-range score into an end bin rather than dropping it', () => {
    const distribution = toScoreDistribution(
      [retrieval({ topScore: 4.5 }), retrieval({ topScore: -1 })],
      'embedding',
    );
    expect(distribution.buckets[9]?.count).toBe(1);
    expect(distribution.buckets[0]?.count).toBe(1);
  });
});

describe('toRetrievalTrendRows', () => {
  it('emits one row per hour of the window, zeroes included', () => {
    const rows = toRetrievalTrendRows(
      [retrieval(), retrieval({ zeroHit: true })],
      new Date('2026-08-04T13:10:00.000Z'),
    );

    expect(rows).toHaveLength(24);
    expect(rows.at(-1)?.label).toBe('13:00');
    // A quiet hour stays in the series as a zero, so an outage reads as a trough not a gap.
    expect(rows.at(-1)).toEqual({ label: '13:00', retrievals: 0, zeroHits: 0 });
    expect(rows.at(-2)).toEqual({ label: '12:00', retrievals: 2, zeroHits: 1 });
  });
});

describe('breakdowns and tables', () => {
  it('groups by store and by retriever, biggest first, with a placeholder for the absent case', () => {
    const retrievals = [
      retrieval({ store: 'redis' }),
      retrieval({ store: 'redis' }),
      retrieval({ store: null, retriever: 'keyword' }),
    ];

    expect(toStoreSegments(retrievals)).toEqual([
      { label: 'redis', value: 2 },
      { label: '—', value: 1 },
    ]);
    expect(toRetrieverSegments(retrievals)).toEqual([
      { label: 'embedding', value: 2 },
      { label: 'keyword', value: 1 },
    ]);
  });

  it('rolls up per collection, busiest first', () => {
    const rows = toCollectionRows([
      retrieval({ collection: 'policy', durationMs: 10, topScore: 0.4 }),
      retrieval({ collection: 'policy', durationMs: 90, topScore: 0.6, zeroHit: true }),
      retrieval({ collection: 'manuals', durationMs: 20, topScore: null }),
    ]);

    expect(rows[0]).toEqual({
      collection: 'policy',
      store: 'redis',
      retrievals: 2,
      zeroHits: 1,
      p95Ms: 90,
      meanTopScore: 0.5,
    });
    expect(rows[1]?.meanTopScore).toBe('—');
  });

  it('lists the slowest retrievals worst-first, skipping unmeasured ones', () => {
    const rows = toSlowestRows([
      retrieval({ durationMs: 40 }),
      retrieval({ durationMs: 900 }),
      retrieval({ durationMs: null }),
    ]);

    expect(rows.map((row) => row.durationMs)).toEqual([900, 40]);
    expect(rows[0]?.at).toBe(AT.toISOString());
  });
});
