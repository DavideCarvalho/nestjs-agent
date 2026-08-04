import { AsyncLocalStorage } from 'node:async_hooks';
import type { Passage, RetrieveOptions, Retriever } from '@dudousxd/nestjs-agent-core';
import { channelName, emit, getChannel } from '@dudousxd/nestjs-diagnostics';
import {
  type RetrievalDescriptor,
  type RetrieverKind,
  type VectorStoreKind,
  describeRetrieval,
} from './retrieval-descriptor.js';

/**
 * Retrieval telemetry: one diagnostics event per retrieval, carrying how long it took, how much came
 * back, how good it was, and what served it.
 *
 * Until this existed, retrieval reached Telescope only as the *tool call* that wrapped it (see
 * `retrieval-tool.ts`), which says a retrieval happened and nothing else. The questions an operator
 * actually arrives with — is retrieval slow, is it returning nothing, is one collection colder than
 * the rest, did the scores collapse after a model swap — are all invisible in a tool-call row,
 * because a tool call that returns zero passages and one that returns five perfect ones are the same
 * row with the same `ok` status.
 *
 * ## One seam, not six
 *
 * Instrumentation is a WRAPPER over the core `Retriever` SPI ({@link instrumentRetriever}), not code
 * inside each retriever. Every retriever in this package — and every retriever outside it — is the
 * same one-method interface, so one wrapper covers all of them, including ones this package has
 * never heard of. The alternative, an `emit` inside each of the six `retrieve` methods, would have
 * had to be repeated in each, skipped by third-party retrievers entirely, and would have double- and
 * triple-counted the composed ones (a hybrid over two legs emitting three events for one retrieval).
 *
 * ## How a composed retrieval reports
 *
 * **The outermost instrumented retriever in a call tree emits; anything instrumented inside it stays
 * silent.** A retrieval is one question the caller asked, so it is one event no matter how many
 * retrievers cooperated to answer it: `RerankingRetriever` over a `HybridRetriever` over a dense and
 * a lexical leg is ONE retrieval, reported as `retriever: 'reranking'` with the duration of the
 * whole thing and the scores the caller actually got back.
 *
 * The suppression is enforced with an {@link AsyncLocalStorage} flag rather than by asking hosts to
 * wrap carefully, because the wrapping that double-counts is the natural one: a host that wraps its
 * top-level retriever and *also* wraps the dense leg it shares with another code path has not made a
 * mistake, and would otherwise get two events per retrieval, a zero-hit rate computed over a mixture
 * of legs and composites, and a retrieval count roughly twice its query count.
 *
 * ## Opt-out safety, and what the hot path pays
 *
 * The event goes out on `aviary:rag:retrieval` via `@dudousxd/nestjs-diagnostics`, whose `emit` is
 * gated on `channel.hasSubscribers` and never throws. This wrapper checks that same gate BEFORE it
 * does anything at all — no clock read, no `AsyncLocalStorage.run`, no score arithmetic — and
 * delegates straight through when nothing is listening. A host that wires this package without
 * Telescope (or any subscriber) pays two `Map` lookups and a boolean per retrieval, and nothing else
 * changes: the wrapper returns the base retriever's passages verbatim, and rethrows its errors
 * unchanged.
 *
 * ## Why this channel is not merged into the typed `ChannelRegistry`
 *
 * `@dudousxd/nestjs-agent-rag-media` already emits `media.ingested`/`media.removed`/`media.skipped`/
 * `media.failed` on the same `rag` lib, and flip's host app emits `rag:search` on it. Declaring
 * `ChannelRegistry['rag'] = { retrieval: RagRetrievalEvent }` here would narrow `EventOf<'rag'>` to
 * this one key process-wide and turn every one of those sibling emits into a compile error in any
 * project that installs both packages. The payload stays typed where it matters — {@link emitRagRetrieval}
 * takes {@link RagRetrievalEvent} — and the wire contract is documented below instead.
 */

/** The diagnostics lib segment. Shared with `@dudousxd/nestjs-agent-rag-media`'s `media.*` events. */
export const RAG_DIAGNOSTIC_LIB = 'rag';

/** The diagnostics event segment. */
export const RAG_RETRIEVAL_EVENT = 'retrieval';

/**
 * The full channel name a subscriber listens on: `aviary:rag:retrieval`. This is the wire contract —
 * `@dudousxd/nestjs-agent-telescope` subscribes to this exact string rather than importing this
 * package, which is what keeps the telescope extension free of a dependency on the retrieval stack
 * (and lets a host that uses neither still observe retrieval with a bare `diagnostics_channel`
 * subscription).
 */
export const RAG_RETRIEVAL_CHANNEL = channelName(RAG_DIAGNOSTIC_LIB, RAG_RETRIEVAL_EVENT);

/**
 * The payload of one retrieval event. Counts, durations, kinds and scores only — never the query
 * text and never passage text. Both are user content, and this lands in an ops store with a short
 * retention window and a Slack-facing redaction budget; everything here is safe to put on a
 * dashboard and is what tells the failure modes apart anyway.
 *
 * The DURATION is not in here: it rides the envelope (`emit`'s `opts.durationMs`), which is the field
 * Telescope's OTel exporter turns into a latency histogram. Putting it in the payload instead would
 * have made retrieval latency a number somebody reads out of a JSON blob rather than a graph.
 */
export interface RagRetrievalEvent {
  /** Which strategy answered — the OUTERMOST one, for a composed retriever. */
  retriever: RetrieverKind;
  /** Which backend held the chunks. Absent for an in-process retriever, or when legs disagree. */
  store?: VectorStoreKind;
  /** Store namespace (pg table / RediSearch index), or the host's logical collection. */
  collection?: string;
  /** What the caller asked for, so `chunks < topK` is readable as "the corpus ran out". */
  topK: number;
  /** How many passages came back. */
  chunks: number;
  /**
   * `chunks === 0`. Carried as its own flag rather than left to be derived, because the zero-hit RATE
   * is the headline number and deriving it means every consumer re-deriving the same predicate.
   */
  zeroHit: boolean;
  /** Best score in the result, rounded to 4dp. Absent on a zero-hit. */
  topScore?: number;
  /** Mean score across the result, rounded to 4dp. Absent on a zero-hit. */
  meanScore?: number;
  /**
   * The retrieval threw. Reported rather than dropped because a failed retrieval and an empty one
   * look identical from the agent's side — both become "I couldn't find anything" — so a channel
   * that only carried successes would go quiet exactly when retrieval broke.
   */
  failed: boolean;
  /** The error message, when `failed`. */
  error?: string;
}

/** Publish one retrieval event. `durationMs` rides the envelope; see {@link RagRetrievalEvent}. */
export function emitRagRetrieval(event: RagRetrievalEvent, durationMs: number): void {
  emit(RAG_DIAGNOSTIC_LIB, RAG_RETRIEVAL_EVENT, event, { durationMs });
}

export interface InstrumentRetrieverOptions {
  /**
   * Override the auto-detected {@link RetrievalDescriptor}, field by field. Needed for a retriever or
   * store from outside this package (which reports `retriever: 'unknown'` and no store), and for a
   * host that wants its own naming.
   */
  describe?: RetrievalDescriptor;
  /**
   * The logical collection this retrieval searched, when the store namespace is not it. Pass a
   * function to read it off the call's metadata filter — the multi-tenant shape, where one index
   * holds every collection and the filter picks one:
   *
   * ```ts
   * instrumentRetriever(retriever, {
   *   collection: (filter) => (typeof filter?.collectionId === 'string' ? filter.collectionId : undefined),
   * })
   * ```
   *
   * Returning `undefined` falls back to the store namespace, which is the right answer for a query
   * scoped to many collections at once: a breakdown panel needs ONE label per retrieval, and
   * inventing a synthetic `"a+b+c"` bucket would produce a chart whose slices are combinations
   * rather than collections.
   */
  collection?: string | ((filter: Record<string, unknown> | undefined) => string | undefined);
}

/**
 * The default a retriever falls back to when the caller names no `topK` — every retriever in this
 * package uses `options.topK ?? 5`, so reporting anything else here would make `chunks < topK`
 * misread as truncation on exactly the calls that did not ask for a limit.
 */
const DEFAULT_TOP_K = 5;

/**
 * Set for the duration of an instrumented `retrieve`, so an instrumented retriever running INSIDE
 * another one knows it is a leg and stays silent. See the composed-retrieval section above.
 */
const inRetrieval = new AsyncLocalStorage<true>();

/** Round to 4dp — enough to see a score distribution move, short enough to keep the payload small. */
function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/** Top + mean score, skipping any passage whose `score` is not a finite number. */
function scoreStats(passages: Passage[]): { topScore?: number; meanScore?: number } {
  const scores = passages.map((passage) => passage.score).filter((score) => Number.isFinite(score));
  if (scores.length === 0) {
    return {};
  }
  const sum = scores.reduce((total, score) => total + score, 0);
  return { topScore: round4(Math.max(...scores)), meanScore: round4(sum / scores.length) };
}

class InstrumentedRetriever implements Retriever {
  constructor(
    private readonly base: Retriever,
    private readonly options: InstrumentRetrieverOptions = {},
  ) {}

  /** Transparent to detection: wrapping a retriever must not turn it into an `unknown` one. */
  describeRetrieval(): RetrievalDescriptor {
    return { ...describeRetrieval(this.base), ...this.options.describe };
  }

  async retrieve(query: string, options: RetrieveOptions = {}): Promise<Passage[]> {
    // Both gates before any work: nothing subscribed, or we are a leg of an outer instrumented
    // retrieval that will report the whole thing itself.
    if (!getChannel(RAG_DIAGNOSTIC_LIB, RAG_RETRIEVAL_EVENT).hasSubscribers) {
      return this.base.retrieve(query, options);
    }
    if (inRetrieval.getStore() === true) {
      return this.base.retrieve(query, options);
    }

    const descriptor = this.describeRetrieval();
    const topK = options.topK ?? DEFAULT_TOP_K;
    const startedAt = Date.now();
    try {
      const passages = await inRetrieval.run(true, () => this.base.retrieve(query, options));
      emitRagRetrieval(
        {
          retriever: descriptor.retriever ?? 'unknown',
          ...(descriptor.store !== undefined ? { store: descriptor.store } : {}),
          ...this.collectionOf(options.filter, descriptor),
          topK,
          chunks: passages.length,
          zeroHit: passages.length === 0,
          ...scoreStats(passages),
          failed: false,
        },
        Date.now() - startedAt,
      );
      return passages;
    } catch (error) {
      emitRagRetrieval(
        {
          retriever: descriptor.retriever ?? 'unknown',
          ...(descriptor.store !== undefined ? { store: descriptor.store } : {}),
          ...this.collectionOf(options.filter, descriptor),
          topK,
          chunks: 0,
          zeroHit: true,
          failed: true,
          error: error instanceof Error ? error.message : String(error),
        },
        Date.now() - startedAt,
      );
      throw error;
    }
  }

  /** The host's collection for this call, else the store namespace, else nothing. */
  private collectionOf(
    filter: Record<string, unknown> | undefined,
    descriptor: RetrievalDescriptor,
  ): { collection?: string } {
    const { collection } = this.options;
    const resolved =
      typeof collection === 'function' ? collection(filter) : (collection ?? descriptor.collection);
    return resolved !== undefined ? { collection: resolved } : {};
  }
}

/**
 * Wrap a retriever so every `retrieve` publishes a {@link RagRetrievalEvent} on
 * {@link RAG_RETRIEVAL_CHANNEL}. Wrap the retriever you actually hand to the agent — the outermost
 * one — and nothing else needs changing:
 *
 * ```ts
 * const retriever = instrumentRetriever(
 *   new HybridRetriever([new EmbeddingRetriever(embedder, store), new LexicalRetriever(store)]),
 * );
 * ```
 *
 * {@link createRetrievalTool} already does this for the tool it builds, so agentic retrieval is
 * instrumented with no host change at all; call this directly for inject-mode retrieval
 * (`AgentModule.forRoot({ retrieval })`) or for a host that calls `retrieve` itself. Wrapping twice
 * is harmless — see the composed-retrieval section above.
 */
export function instrumentRetriever(
  retriever: Retriever,
  options: InstrumentRetrieverOptions = {},
): Retriever {
  return new InstrumentedRetriever(retriever, options);
}
