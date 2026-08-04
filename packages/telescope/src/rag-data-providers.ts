import type { DataProvider, ExtensionContext } from '@dudousxd/nestjs-telescope';
import { TELESCOPE_STORAGE } from '@dudousxd/nestjs-telescope';
import { RAG_ENTRY_TYPE } from './rag-telescope.watcher.js';

/**
 * RAG data providers for the "Agent" Telescope tab: how long retrieval takes, how much it returns,
 * how good the scores are, and which store answered. They read the `agent-rag` entries
 * {@link import('./rag-telescope.watcher.js').RagTelescopeWatcher} records from the
 * `aviary:rag:retrieval` diagnostics channel.
 *
 * ## Why the ephemeral channel here, when `agent-data-providers.ts` says to prefer the durable one
 *
 * That file's deprecation note is right about what it covers: anything that is a governance FACT —
 * a tool call, its approval, what a run cost — belongs in `AGENT_GOVERNANCE_QUERIES`, because it is
 * read as history, must survive a restart, and already has a durable write on the path.
 *
 * Retrieval telemetry is not that, and routing it there would have cost more than it bought. There
 * is no durable write to piggyback on: `AGENT_GOVERNANCE_QUERIES` is implemented over the agent
 * store's own tables, retrieval happens inside `@dudousxd/nestjs-agent-rag` (which holds no store
 * handle and has no business acquiring one), and giving it one would mean a new table plus a
 * migration in `store-mikro-orm` AND `store-drizzle` AND `testing`, and a row written per retrieval —
 * write amplification on the hot path of the one operation an agent performs most often. What that
 * buys is that a latency p95 and a zero-hit rate survive a pod restart. Those are rolling
 * operational signals, read as "what is retrieval doing lately", over a window Telescope's own
 * retention already bounds.
 *
 * The honest consequence, so nobody is surprised by it: **these panels count only what this process
 * has seen since it started, and only as far back as Telescope's retention.** They are a live view,
 * not a ledger. A host that needs retrieval history to outlive a deploy has two supported routes,
 * neither of which requires a change here: subscribe to `aviary:rag:retrieval` itself and persist
 * what it wants, and/or contribute its own providers and panels through
 * `agentTelescopeExtension({ providers, sections })`.
 */

/**
 * How many retrieval entries a panel scans. Matches the agent providers' window. Entries come back
 * NEWEST FIRST (the storage SPI's `get` sorts descending), which is what lets the "recent" tables
 * take a prefix rather than a suffix.
 */
const RETRIEVAL_WINDOW = 5_000;

/** Rows in the by-collection and slowest-retrieval tables. */
const TABLE_LIMIT = 10;

/** Hours of trend shown — one day, which is longer than a default retention window anyway. */
const TREND_HOURS = 24;

/** Placeholder for a dimension the event did not carry (an in-process retriever has no store). */
const NO_VALUE = '—';

/** One retrieval, normalized out of an entry's untyped `content`. */
export interface RagRetrieval {
  at: Date;
  retriever: string;
  store: string | null;
  collection: string | null;
  chunks: number;
  zeroHit: boolean;
  topScore: number | null;
  durationMs: number | null;
  failed: boolean;
}

interface BreakdownSegment {
  label: string;
  value: number;
}

interface DistributionBucket {
  label: string;
  count: number;
}

/** One row of the per-collection table. */
interface CollectionRow {
  collection: string;
  store: string;
  retrievals: number;
  zeroHits: number;
  p95Ms: number | string;
  meanTopScore: number | string;
}

/** One row of the slowest-retrievals table. */
interface SlowestRow {
  at: string;
  retriever: string;
  store: string;
  collection: string;
  chunks: number;
  topScore: number | string;
  durationMs: number | string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' ? value : null;
}

function readNumber(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * The Telescope storage surface these providers use, narrowed structurally so the DI-resolved
 * binding needs no cast — the same posture `agent-governance-providers.ts` takes with
 * `AGENT_GOVERNANCE_QUERIES`.
 */
interface RetrievalEntryStorage {
  get(query: { type?: string; limit?: number }): Promise<{ data: unknown[] }>;
}

function isEntryStorage(value: unknown): value is RetrievalEntryStorage {
  return isRecord(value) && typeof value.get === 'function';
}

/**
 * Normalize one storage entry into a {@link RagRetrieval}, or `null` when it is not a retrieval this
 * shaping understands. Field-by-field `typeof` checks rather than a cast: entries are persisted JSON
 * written by a possibly older producer, so "the field is there and is a number" is a runtime
 * question, and a missing `durationMs` must land as `null` (excluded from percentiles) rather than as
 * a `NaN` that silently poisons every aggregate it touches.
 */
export function toRagRetrieval(entry: unknown): RagRetrieval | null {
  if (!isRecord(entry) || !isRecord(entry.content)) {
    return null;
  }
  const content = entry.content;
  const retriever = readString(content, 'retriever');
  if (retriever === null) {
    return null;
  }
  const chunks = readNumber(content, 'chunks') ?? 0;
  const createdAt = entry.createdAt;
  return {
    at: createdAt instanceof Date ? createdAt : new Date(0),
    retriever,
    store: readString(content, 'store'),
    collection: readString(content, 'collection'),
    chunks,
    zeroHit: content.zeroHit === true || chunks === 0,
    topScore: readNumber(content, 'topScore'),
    durationMs: readNumber(content, 'durationMs'),
    failed: content.failed === true,
  };
}

/**
 * Every retrieval in the window, newest first. Takes the resolved binding as `unknown` and narrows it
 * here, so a host whose Telescope storage is missing or unrecognised gets empty panels rather than a
 * 502 on every RAG card — the same degrade-don't-throw posture the governance providers take.
 */
export async function readRetrievals(storage: unknown): Promise<RagRetrieval[]> {
  if (!isEntryStorage(storage)) {
    return [];
  }
  const page = await storage.get({ type: RAG_ENTRY_TYPE, limit: RETRIEVAL_WINDOW });
  const retrievals: RagRetrieval[] = [];
  for (const entry of page.data) {
    const retrieval = toRagRetrieval(entry);
    if (retrieval !== null) {
      retrievals.push(retrieval);
    }
  }
  return retrievals;
}

/** Resolve Telescope's own storage from the host container; `undefined` when the token is unbound. */
function retrievalStorage(ctx: ExtensionContext): unknown {
  try {
    return ctx.moduleRef.get(TELESCOPE_STORAGE, { strict: false });
  } catch {
    return undefined;
  }
}

/** Nearest-rank percentile over an unsorted sample. `null` for an empty sample. */
export function percentile(samples: number[], fraction: number): number | null {
  if (samples.length === 0) {
    return null;
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil(fraction * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1] ?? null;
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/** Fraction (0–1) of retrievals that came back with nothing. `0` over an empty window. */
export function zeroHitRate(retrievals: RagRetrieval[]): number {
  if (retrievals.length === 0) {
    return 0;
  }
  const zeroHits = retrievals.filter((retrieval) => retrieval.zeroHit).length;
  return round(zeroHits / retrievals.length, 4);
}

/** Mean passages returned per retrieval — `topK` minus this is how often the corpus ran out. */
export function meanChunks(retrievals: RagRetrieval[]): number {
  if (retrievals.length === 0) {
    return 0;
  }
  const total = retrievals.reduce((sum, retrieval) => sum + retrieval.chunks, 0);
  return round(total / retrievals.length, 2);
}

/**
 * Fixed latency ladder, in milliseconds. Fixed rather than derived from the data because a
 * histogram whose buckets move between refreshes cannot be compared to the one you looked at a
 * minute ago — the shape changes when the data changes AND when the range does, and there is no way
 * to tell which happened.
 */
const LATENCY_EDGES = [10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000];

function latencyLabel(index: number): string {
  const upper = LATENCY_EDGES[index];
  if (upper === undefined) {
    return `≥${LATENCY_EDGES[LATENCY_EDGES.length - 1] ?? 0}ms`;
  }
  return `${index === 0 ? 0 : (LATENCY_EDGES[index - 1] ?? 0)}–${upper}ms`;
}

/** Latency histogram over the ladder above, plus p50/p95/p99 of the raw samples. */
export function toLatencyDistribution(retrievals: RagRetrieval[]): {
  buckets: DistributionBucket[];
  p50?: number;
  p95?: number;
  p99?: number;
} {
  const samples: number[] = [];
  const counts = new Array<number>(LATENCY_EDGES.length + 1).fill(0);
  for (const { durationMs } of retrievals) {
    if (durationMs === null) {
      continue;
    }
    samples.push(durationMs);
    const found = LATENCY_EDGES.findIndex((edge) => durationMs < edge);
    const index = found === -1 ? LATENCY_EDGES.length : found;
    counts[index] = (counts[index] ?? 0) + 1;
  }
  const buckets = counts.map((count, index) => ({ label: latencyLabel(index), count }));
  const p50 = percentile(samples, 0.5);
  const p95 = percentile(samples, 0.95);
  const p99 = percentile(samples, 0.99);
  return {
    buckets,
    ...(p50 !== null ? { p50 } : {}),
    ...(p95 !== null ? { p95 } : {}),
    ...(p99 !== null ? { p99 } : {}),
  };
}

/** Ten equal bins over `[0, 1]`, the range a cosine similarity lives in. */
const SCORE_BINS = 10;

/**
 * Top-score histogram — **for ONE retriever kind at a time**, which is the whole reason this takes a
 * `retriever` argument instead of bucketing everything it was handed.
 *
 * A `Passage.score` has no shared meaning across strategies: `EmbeddingRetriever` returns a
 * calibrated cosine similarity in `[0, 1]`, a BM25 leg returns an unbounded relevance score in the
 * tens, and `HybridRetriever`'s RRF returns a rank-derived number that lives in a band about one
 * part in fifty wide and says nothing about quality at all (see the score section on
 * `HybridRetriever`). Pouring those into one histogram produces a chart where the bins mean a
 * different thing per bar — and the reading it invites, "our scores collapsed", would be a change in
 * traffic MIX rather than in retrieval quality.
 *
 * So the panel binds `query.retriever: 'embedding'`: the dense leg is the only population whose
 * score is comparable across queries, which is also why `minScore` lives on that retriever alone.
 * Scores outside `[0, 1]` are clamped into the end bins rather than dropped, so a store that reports
 * a distance-derived score still shows up as an obviously-pinned bar instead of an empty chart.
 */
export function toScoreDistribution(
  retrievals: RagRetrieval[],
  retriever: string,
): { buckets: DistributionBucket[]; p50?: number; p95?: number } {
  const samples: number[] = [];
  const counts = new Array<number>(SCORE_BINS).fill(0);
  for (const retrieval of retrievals) {
    if (retrieval.retriever !== retriever || retrieval.topScore === null) {
      continue;
    }
    samples.push(retrieval.topScore);
    const clamped = Math.min(Math.max(retrieval.topScore, 0), 1);
    const index = Math.min(Math.floor(clamped * SCORE_BINS), SCORE_BINS - 1);
    counts[index] = (counts[index] ?? 0) + 1;
  }
  const buckets = counts.map((count, index) => ({
    label: `${round(index / SCORE_BINS, 1)}–${round((index + 1) / SCORE_BINS, 1)}`,
    count,
  }));
  const p50 = percentile(samples, 0.5);
  const p95 = percentile(samples, 0.95);
  return {
    buckets,
    ...(p50 !== null ? { p50: round(p50, 4) } : {}),
    ...(p95 !== null ? { p95: round(p95, 4) } : {}),
  };
}

/** Start of the UTC hour a timestamp falls in. */
function hourStart(at: Date): number {
  return Math.floor(at.getTime() / 3_600_000) * 3_600_000;
}

/**
 * Retrievals and zero-hits per UTC hour, oldest bucket first, over the last {@link TREND_HOURS}.
 * Empty hours are emitted as zeroes so a quiet stretch reads as a gap in the line rather than
 * disappearing and making the outage look like it never happened.
 */
export function toRetrievalTrendRows(
  retrievals: RagRetrieval[],
  now = new Date(),
): Array<{ label: string; retrievals: number; zeroHits: number }> {
  const latest = hourStart(now);
  const earliest = latest - (TREND_HOURS - 1) * 3_600_000;
  const buckets = new Map<number, { retrievals: number; zeroHits: number }>();
  for (let hour = earliest; hour <= latest; hour += 3_600_000) {
    buckets.set(hour, { retrievals: 0, zeroHits: 0 });
  }
  for (const retrieval of retrievals) {
    const bucket = buckets.get(hourStart(retrieval.at));
    if (bucket === undefined) {
      continue;
    }
    bucket.retrievals += 1;
    if (retrieval.zeroHit) {
      bucket.zeroHits += 1;
    }
  }
  return [...buckets.entries()].map(([hour, counts]) => ({
    label: `${new Date(hour).toISOString().slice(11, 13)}:00`,
    retrievals: counts.retrievals,
    zeroHits: counts.zeroHits,
  }));
}

/** Count retrievals by one dimension, biggest first, with a placeholder for the absent case. */
function segmentsBy(
  retrievals: RagRetrieval[],
  pick: (retrieval: RagRetrieval) => string | null,
): BreakdownSegment[] {
  const counts = new Map<string, number>();
  for (const retrieval of retrievals) {
    const label = pick(retrieval) ?? NO_VALUE;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value);
}

/** Retrievals by vector store (`memory`/`pg`/`redis`, or `—` for an in-process retriever). */
export function toStoreSegments(retrievals: RagRetrieval[]): BreakdownSegment[] {
  return segmentsBy(retrievals, (retrieval) => retrieval.store);
}

/** Retrievals by strategy — the composed kind, since that is what answered. */
export function toRetrieverSegments(retrievals: RagRetrieval[]): BreakdownSegment[] {
  return segmentsBy(retrievals, (retrieval) => retrieval.retriever);
}

/** Per-collection rollup, busiest first. `p95Ms`/`meanTopScore` fall back to `—` when unmeasured. */
export function toCollectionRows(retrievals: RagRetrieval[], limit = TABLE_LIMIT): CollectionRow[] {
  const groups = new Map<string, RagRetrieval[]>();
  for (const retrieval of retrievals) {
    const key = retrieval.collection ?? NO_VALUE;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, [retrieval]);
    } else {
      group.push(retrieval);
    }
  }
  return [...groups.entries()]
    .map(([collection, group]) => {
      const durations: number[] = [];
      const scores: number[] = [];
      for (const retrieval of group) {
        if (retrieval.durationMs !== null) {
          durations.push(retrieval.durationMs);
        }
        if (retrieval.topScore !== null) {
          scores.push(retrieval.topScore);
        }
      }
      const p95 = percentile(durations, 0.95);
      const meanScore =
        scores.length === 0 ? null : scores.reduce((sum, score) => sum + score, 0) / scores.length;
      return {
        collection,
        store: group[0]?.store ?? NO_VALUE,
        retrievals: group.length,
        zeroHits: group.filter((retrieval) => retrieval.zeroHit).length,
        p95Ms: p95 === null ? NO_VALUE : Math.round(p95),
        meanTopScore: meanScore === null ? NO_VALUE : round(meanScore, 3),
      };
    })
    .sort((a, b) => b.retrievals - a.retrievals)
    .slice(0, limit);
}

/**
 * The slowest retrievals in the window, worst first — the table an operator opens after the p95
 * moves. Sorted by duration rather than by recency on purpose: "recent retrievals" would be a list
 * of whatever just happened, which the trend already shows in aggregate, whereas the tail is the
 * only place a single pathological query is visible at all.
 */
export function toSlowestRows(retrievals: RagRetrieval[], limit = TABLE_LIMIT): SlowestRow[] {
  return retrievals
    .filter((retrieval) => retrieval.durationMs !== null)
    .sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0))
    .slice(0, limit)
    .map((retrieval) => ({
      at: retrieval.at.toISOString(),
      retriever: retrieval.retriever,
      store: retrieval.store ?? NO_VALUE,
      collection: retrieval.collection ?? NO_VALUE,
      chunks: retrieval.chunks,
      topScore: retrieval.topScore === null ? NO_VALUE : round(retrieval.topScore, 3),
      durationMs: retrieval.durationMs === null ? NO_VALUE : Math.round(retrieval.durationMs),
    }));
}

/** Build a provider from one shaping step over the retrieval window. */
function retrievalProvider(
  name: string,
  format: (retrievals: RagRetrieval[], query: Record<string, unknown> | undefined) => unknown,
): DataProvider {
  return {
    name,
    async resolve(query, ctx) {
      return format(await readRetrievals(retrievalStorage(ctx)), query);
    },
  };
}

/** stat → retrievals in the window. */
export function ragRetrievalsProvider(): DataProvider {
  return retrievalProvider('agent.rag.retrievals', (retrievals) => ({ value: retrievals.length }));
}

/** stat (percent) → share of retrievals that returned nothing. */
export function ragZeroHitRateProvider(): DataProvider {
  return retrievalProvider('agent.rag.zeroHitRate', (retrievals) => ({
    value: zeroHitRate(retrievals),
  }));
}

/** stat → mean passages returned per retrieval. */
export function ragChunksProvider(): DataProvider {
  return retrievalProvider('agent.rag.chunks', (retrievals) => ({ value: meanChunks(retrievals) }));
}

/** distribution → retrieval latency, with p50/p95/p99 markers. */
export function ragLatencyProvider(): DataProvider {
  return retrievalProvider('agent.rag.latency', toLatencyDistribution);
}

/** distribution → top score for ONE retriever kind (`query.retriever`, default `embedding`). */
export function ragScoresProvider(): DataProvider {
  return retrievalProvider('agent.rag.scores', (retrievals, query) => {
    const requested = query?.retriever;
    return toScoreDistribution(retrievals, typeof requested === 'string' ? requested : 'embedding');
  });
}

/** timeseries → retrievals and zero-hits per hour. */
export function ragTrendProvider(): DataProvider {
  return retrievalProvider('agent.rag.trend', (retrievals) => ({
    rows: toRetrievalTrendRows(retrievals),
  }));
}

/** breakdown → retrievals by vector store. */
export function ragStoreBreakdownProvider(): DataProvider {
  return retrievalProvider('agent.rag.byStore', (retrievals) => ({
    segments: toStoreSegments(retrievals),
  }));
}

/** breakdown → retrievals by retriever strategy. */
export function ragRetrieverBreakdownProvider(): DataProvider {
  return retrievalProvider('agent.rag.byRetriever', (retrievals) => ({
    segments: toRetrieverSegments(retrievals),
  }));
}

/** table → per-collection rollup, busiest first. */
export function ragCollectionsTableProvider(): DataProvider {
  return retrievalProvider('agent.rag.byCollection', (retrievals) => ({
    rows: toCollectionRows(retrievals),
  }));
}

/** table → the slowest retrievals in the window. */
export function ragSlowestTableProvider(): DataProvider {
  return retrievalProvider('agent.rag.slowest', (retrievals) => ({
    rows: toSlowestRows(retrievals),
  }));
}
