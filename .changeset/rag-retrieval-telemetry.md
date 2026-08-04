---
'@dudousxd/nestjs-agent-rag': minor
---

Retrieval telemetry: one `aviary:rag:retrieval` event per retrieval — duration, chunks returned, score distribution, retriever kind, store and collection.

Retrieval reached observability only as the tool call that wrapped it. That row says a retrieval happened and nothing else: a retrieval that returned zero passages and one that returned five perfect ones are the same row, with the same `ok` status. Every question an operator actually arrives with — is retrieval slow, is it returning nothing, is one collection colder than the rest, did the scores fall off a cliff after the embedding model changed — was unanswerable from that side.

The event carries counts, durations and kinds only. Never the query text, never passage text; the duration rides the envelope (`opts.durationMs`), which is the field Telescope's OTel exporter turns into a latency histogram rather than a number somebody reads out of a JSON blob.

```ts
{ retriever, store?, collection?, topK, chunks, zeroHit, topScore?, meanScore?, failed, error? }
```

`createRetrievalTool` instruments the retriever it wraps by default (opt out with `telemetry: false`), so agentic retrieval is covered with no host change. Every other call path — inject mode, a service that calls `retrieve` itself — wraps once with `instrumentRetriever(retriever)`.

Instrumentation is a wrapper over the `Retriever` SPI, not code inside each retriever. One wrapper covers all six shipped retrievers and every retriever outside this package; an `emit` per `retrieve` method would have had to be repeated six times, missed third-party retrievers entirely, and triple-counted a hybrid over two legs.

**A composed retrieval is one event.** The outermost instrumented retriever reports; anything instrumented inside it stays silent, enforced with an `AsyncLocalStorage` flag rather than by asking hosts to wrap carefully. Reranking over hybrid over a dense and a lexical leg is one retrieval, reported as `retriever: 'reranking'` with the duration and the scores the caller actually got back. Wrapping a leg as well as the composite is safe — the alternative was a retrieval count roughly twice the query count and a zero-hit rate computed over a mixture of legs and composites.

**It costs nothing when nobody listens.** `emit` is gated on `channel.hasSubscribers`, and the wrapper checks the same gate before it reads a clock, enters the `AsyncLocalStorage` scope, or touches a score — a host with no subscriber pays two map lookups and a boolean per retrieval. Behaviour is unchanged either way: passages come back verbatim, a throwing retriever is reported as `failed` and rethrown unchanged.

Retrievers and stores now describe themselves for this (`describeRetrieval()`, an optional capability rather than a member of `VectorStore` or `Retriever`, which would have broken every existing implementation for a field only observability reads). A hybrid reports a store only when every leg agrees on one: the dense and lexical halves of the same RediSearch index genuinely were served by that store, whereas a hybrid fusing pgvector with an in-process BM25 index was not served by either alone, and picking the first leg would have quietly attributed the whole retrieval to a store that answered half of it.

Also exported: `RAG_RETRIEVAL_CHANNEL` (the wire contract — subscribe to it directly to persist retrieval history that outlives a restart), `RagRetrievalEvent`, `RetrievalDescriptor`, `RetrieverKind`, `VectorStoreKind`, and the `describeRetrieval` / `describeSource` / `describeSharedSource` helpers.

The channel is deliberately not declared on the typed `ChannelRegistry`: `@dudousxd/nestjs-agent-rag-media` already emits `media.*` on the same `rag` lib, and narrowing `EventOf<'rag'>` to this one key would turn each of those sibling emits into a compile error in any project that installs both.
