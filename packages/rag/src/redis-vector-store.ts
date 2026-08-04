import type { Passage } from '@dudousxd/nestjs-agent-core';
import { filterMatchesNothing } from './filter.js';
import { type MetadataPatch, applyMetadataPatch, isEmptyMetadataPatch } from './metadata-patch.js';
import type { RetrievalDescriptor } from './retrieval-descriptor.js';
import {
  type IndexedDocument,
  type LexicalVectorStore,
  type ListChunksOptions,
  type StoredChunk,
  UnsafeRemovalError,
  type VectorRecord,
  type VectorSearchOptions,
  type VectorStore,
  chunkIndexOf,
  documentIdOf,
} from './vector-store.js';

/**
 * The minimal Redis surface {@link RedisVectorStore} needs: send a raw command and get the reply.
 * Both `node-redis` (`client.sendCommand(args)`) and `ioredis` (wrap `redis.call`) satisfy it — so
 * this package pulls in NO Redis driver (bring your own, like the other adapters). Requires the
 * RediSearch module (Redis Stack / Redis 8+).
 */
export interface RedisSearchClient {
  sendCommand(args: (string | Buffer)[]): Promise<unknown>;
}

/**
 * The index that already exists in Redis contradicts this store's configuration in a way that cannot
 * be repaired in place. Thrown by {@link RedisVectorStore.ensureSchema} — which would otherwise have
 * returned happily and left every subsequent query quietly wrong.
 *
 * The canonical case is a changed embedding width (a model swap, 1024 → 1536): RediSearch fixes a
 * vector field's `DIM` at `FT.CREATE`, and every vector already stored was produced by the OLD model,
 * so there is no in-place fix — the index has to be dropped and the corpus re-embedded. That is
 * destructive and belongs to the host, never to a boot-time `ensureSchema`.
 */
export class RedisVectorSchemaMismatchError extends Error {
  constructor(
    /** The RediSearch index that was inspected. */
    readonly index: string,
    /** The index attribute that differs (e.g. `embedding`, `meta_tenant`). */
    readonly field: string,
    /** What this store is configured for. */
    readonly expected: string,
    /** What `FT.INFO` reports the live index has. */
    readonly actual: string,
    remedy: string,
  ) {
    super(
      `RediSearch index "${index}" disagrees with this RedisVectorStore's configuration: ` +
        `field "${field}" is ${actual}, expected ${expected}. ${remedy}`,
    );
    this.name = 'RedisVectorSchemaMismatchError';
  }
}

export interface RedisVectorStoreOptions {
  /** RediSearch index name. Default `agent_rag_idx`. */
  index?: string;
  /** Key prefix for the per-chunk hashes. Default `agent_rag:`. */
  prefix?: string;
  /** Embedding width — must match your model (e.g. 1536). Default 1536. */
  dimensions?: number;
  /**
   * Metadata keys to index as filterable TAG fields. RediSearch needs filter fields declared up
   * front, so only keys listed here can be passed in `search`'s `filter`. Default none.
   */
  filterableFields?: string[];
  /**
   * RediSearch scorer used by {@link RedisVectorStore.searchText}. Default `BM25` — the standard
   * lexical ranking, and the same family the in-process `KeywordRetriever` implements. Override for
   * a server that names it differently (`BM25STD` on newer builds) or to pick `TFIDF`/`DISMAX`.
   */
  lexicalScorer?: string;
}

/**
 * A RediSearch-backed {@link VectorStore} — HNSW + cosine over Redis, the ecosystem-native option
 * for anyone already running Redis (see `-transport-redis`). Chunks are hashes under `prefix`, the
 * embedding a FLOAT32 vector field; `search` is a KNN query. Call {@link RedisVectorStore.ensureSchema}
 * once at boot to create the index.
 *
 * The chunk text is declared as a RediSearch `TEXT` field, so this store also satisfies
 * {@link LexicalVectorStore}: {@link RedisVectorStore.searchText} is BM25 over that same index —
 * the lexical half of hybrid search with no second index to build, feed, or invalidate.
 */
export class RedisVectorStore implements LexicalVectorStore {
  private readonly index: string;
  private readonly prefix: string;
  private readonly dimensions: number;
  private readonly filterableFields: string[];
  private readonly lexicalScorer: string;

  constructor(
    private readonly client: RedisSearchClient,
    options: RedisVectorStoreOptions = {},
  ) {
    this.index = options.index ?? 'agent_rag_idx';
    this.prefix = options.prefix ?? 'agent_rag:';
    this.dimensions = options.dimensions ?? 1536;
    this.filterableFields = options.filterableFields ?? [];
    this.lexicalScorer = options.lexicalScorer ?? 'BM25';
  }

  /**
   * Telemetry self-description — the RediSearch INDEX, not the key prefix: the index is what both
   * legs query, and two stores sharing one index (the dense and lexical halves of a hybrid) must
   * report the same namespace or `describeSharedSource` would see them disagree and drop the store.
   */
  describeRetrieval(): RetrievalDescriptor {
    return { store: 'redis', collection: this.index };
  }

  /**
   * Idempotent, and drift-aware: create the HNSW/cosine index if `FT.INFO` says it doesn't exist —
   * and if it DOES exist, compare what's there against this store's configuration instead of
   * assuming they agree. An index that outlives a config change is the normal case (schemas live in
   * Redis, config lives in a redeployed process), and the two failure modes it produces are both
   * invisible at runtime: a `filterableFields` entry added later has no `meta_*` TAG, so every search
   * filtering on it matches *nothing*; a changed `dimensions` leaves the index on the old width, so
   * writes are rejected or KNN ranks garbage. Neither raises anything on its own.
   *
   * The two are repaired differently, because only one of them CAN be repaired:
   *
   * - **A missing filterable TAG is additive** → `FT.ALTER … SCHEMA ADD`. Nothing that already works
   *   changes, so doing it automatically is safe. Note the chunks written *before* the alter carry no
   *   `meta_*` hash field at all (`upsert` only writes the fields configured at the time), so they
   *   only become filterable on that key once they're re-ingested — the schema is repaired here, the
   *   backfill is the host's call.
   * - **A dimension (or field-type) change is not repairable** → {@link RedisVectorSchemaMismatchError}.
   *   It needs a drop + full reindex, which would destroy the host's corpus; failing loudly at boot is
   *   the only honest option.
   *
   * If `FT.INFO` comes back in a shape this parser doesn't recognise, no drift is inferred — an
   * unreadable reply must not be turned into a false alarm that blocks a boot.
   */
  async ensureSchema(): Promise<void> {
    let info: unknown;
    try {
      info = await this.client.sendCommand(['FT.INFO', this.index]);
    } catch {
      await this.createIndex();
      return;
    }
    await this.reconcileSchema(info);
  }

  /** Repair what can be repaired in place; throw on what can't. */
  private async reconcileSchema(info: unknown): Promise<void> {
    const attributes = parseIndexAttributes(info);
    if (attributes.size === 0) {
      return;
    }

    const vector = attributes.get('embedding');
    if (vector?.dimensions !== undefined && vector.dimensions !== this.dimensions) {
      throw new RedisVectorSchemaMismatchError(
        this.index,
        'embedding',
        `DIM ${this.dimensions}`,
        `DIM ${vector.dimensions}`,
        `A vector field's width is fixed at FT.CREATE and every stored embedding has the old one, so this cannot be altered in place: drop the index (FT.DROPINDEX ${this.index} DD) and re-ingest with the new embedding model.`,
      );
    }

    const missing: string[] = [];
    for (const field of this.filterableFields) {
      const name = `meta_${field}`;
      const existing = attributes.get(name);
      if (existing === undefined) {
        missing.push(name);
      } else if (existing.type !== 'TAG') {
        throw new RedisVectorSchemaMismatchError(
          this.index,
          name,
          'TAG',
          existing.type,
          `A field's type cannot be changed in place: drop the index (FT.DROPINDEX ${this.index} DD) and re-ingest, or rename the metadata key.`,
        );
      }
    }
    for (const name of missing) {
      await this.client.sendCommand(['FT.ALTER', this.index, 'SCHEMA', 'ADD', name, 'TAG']);
    }
  }

  private async createIndex(): Promise<void> {
    const schema: string[] = ['text', 'TEXT', 'source', 'TAG', 'metadata_json', 'TEXT', 'NOINDEX'];
    for (const field of this.filterableFields) {
      schema.push(`meta_${field}`, 'TAG');
    }
    schema.push(
      'embedding',
      'VECTOR',
      'HNSW',
      '6',
      'TYPE',
      'FLOAT32',
      'DIM',
      String(this.dimensions),
      'DISTANCE_METRIC',
      'COSINE',
    );
    await this.client.sendCommand([
      'FT.CREATE',
      this.index,
      'ON',
      'HASH',
      'PREFIX',
      '1',
      this.prefix,
      'SCHEMA',
      ...schema,
    ]);
  }

  async upsert(records: VectorRecord[]): Promise<void> {
    for (const record of records) {
      const args: (string | Buffer)[] = [
        'HSET',
        `${this.prefix}${record.id}`,
        'text',
        record.text,
        'embedding',
        encodeVector(record.embedding),
      ];
      if (record.source !== undefined) {
        args.push('source', record.source);
      }
      if (record.metadata !== undefined) {
        args.push('metadata_json', JSON.stringify(record.metadata));
        for (const field of this.filterableFields) {
          const value = record.metadata[field];
          if (value !== undefined) {
            args.push(`meta_${field}`, encodeTag(value));
          }
        }
      }
      await this.client.sendCommand(args);
    }
  }

  /**
   * Single-document deletion, by `SCAN … MATCH`.
   *
   * This deliberately stays a keyspace scan even though the rest of this class no longer needs one.
   * The obvious optimisation is to stamp each chunk with its document id as an implicit filterable
   * TAG at {@link RedisVectorStore.upsert} and turn `remove` into an `FT.SEARCH` — and that is exactly
   * the change that must not ship, because chunks written *before* it carry no such field. `FT.SEARCH`
   * would find zero of them, `remove` would return happily, and a document that has been "deleted"
   * would go on being retrieved. A delete that silently stops deleting is worse than a slow one, and
   * the library cannot tell a fully-migrated corpus from an unmigrated one: both look like "this
   * document has no indexed chunks". Nor is a search-then-fall-back-to-scan hybrid safe — a document
   * re-ingested after the upgrade has *some* stamped chunks, so the search finds hits, the fallback
   * never runs, and the unstamped tail survives. That is the same silent failure with a smaller blast
   * radius, which makes it harder to notice rather than less wrong.
   *
   * The consumer pain this was measured against — deleting a whole collection, one `remove` per
   * document — is answered instead by {@link RedisVectorStore.removeWhere} (one filtered query, no
   * keyspace scan at all) and {@link RedisVectorStore.removeMany} (one scan for N documents rather
   * than N scans). Neither depends on a field that older chunks lack, so neither has a migration.
   */
  async remove(documentId: string): Promise<void> {
    const keys = await this.chunkKeys(documentId);
    if (keys.length > 0) {
      await this.client.sendCommand(['DEL', ...keys]);
    }
  }

  /**
   * Rewrite the metadata of every chunk of `documentId` in place, leaving `text` and `embedding`
   * alone. See {@link VectorStore.updateMetadata} for the merge semantics and the return value.
   *
   * The care this needs is entirely about the fact that a chunk stores its metadata **twice**: as the
   * `metadata_json` blob (what {@link RedisVectorStore.search} reads back onto a `Passage`) and as
   * `meta_<field>` TAG fields (what RediSearch actually filters on, and only for the declared
   * `filterableFields`). Move one without the other and the store lies to itself — a chunk that
   * filters as the old value but reports the new one, or the reverse — so this method rewrites both
   * from the same merged object:
   *
   * - a patched key that is **not** filterable lands in `metadata_json` only, and no stray `meta_*`
   *   field is invented for it (it would be dead weight the index does not know about);
   * - a patched key that **is** filterable also rewrites its TAG, using the identical encoding
   *   `upsert` uses, so an updated chunk is indistinguishable from a re-ingested one;
   * - a filterable key the patch **removes** has its TAG `HDEL`-ed, not left behind as a tag matching
   *   a value the document no longer carries.
   *
   * A plain `HSET` is all the index needs: RediSearch re-indexes a hash the moment it is written, so
   * the very next `FT.SEARCH` sees the new TAG and no longer the old one — no reindex command, and
   * no need to rewrite the (untouched, and expensive) vector to nudge it. `HDEL` on an indexed field
   * likewise drops it from the index. Verified against a real Redis Stack in
   * `redis-vector-store.db.spec.ts`, not assumed.
   *
   * Removals are issued **before** the write, so the only window a concurrent reader can observe is
   * "TAG already gone, `metadata_json` not yet updated" — which fails *closed* on a filter carrying
   * an ACL. The reverse order would briefly leave a document tagged with a capability its metadata no
   * longer claims. Read-modify-write across chunks is not transactional; concurrent writers to the
   * same chunk are last-writer-wins, exactly as two concurrent `upsert`s already are.
   */
  async updateMetadata(documentId: string, patch: MetadataPatch): Promise<number> {
    if (isEmptyMetadataPatch(patch)) {
      return 0;
    }
    const keys = await this.chunkKeys(documentId);
    let updated = 0;
    for (const key of keys) {
      const raw = await this.client.sendCommand(['HGET', key, 'metadata_json']);
      const current = parseMetadata(raw === null || raw === undefined ? undefined : toStr(raw));
      const next = applyMetadataPatch(current.metadata, patch);

      const args: (string | Buffer)[] = ['HSET', key, 'metadata_json', JSON.stringify(next)];
      const stale: string[] = [];
      for (const field of this.filterableFields) {
        const value = next[field];
        if (value !== undefined) {
          args.push(`meta_${field}`, encodeTag(value));
        } else if (current.metadata?.[field] !== undefined) {
          stale.push(`meta_${field}`);
        }
      }
      if (stale.length > 0) {
        await this.client.sendCommand(['HDEL', key, ...stale]);
      }
      await this.client.sendCommand(args);
      updated += 1;
    }
    return updated;
  }

  /**
   * Every chunk key that currently EXISTS for `documentId` — the bare `${prefix}${documentId}` plus
   * the `${documentId}#<n>` chunks found by `SCAN`. One definition of "chunk belongs to document",
   * shared by `remove` and `updateMetadata`, so the two can never disagree about which keys a
   * document owns. The glob is escaped so `gone` does not reach into `goner#0`.
   */
  private async chunkKeys(documentId: string): Promise<string[]> {
    const keys = new Set<string>();
    const bare = `${this.prefix}${documentId}`;
    const exists = await this.client.sendCommand(['EXISTS', bare]);
    if (Number(toStr(exists)) > 0) {
      keys.add(bare);
    }
    const pattern = `${this.prefix}${escapeGlob(documentId)}#*`;
    let cursor = '0';
    do {
      const reply = await this.client.sendCommand([
        'SCAN',
        cursor,
        'MATCH',
        pattern,
        'COUNT',
        '256',
      ]);
      const page = parseScanReply(reply);
      cursor = page.cursor;
      for (const key of page.keys) {
        keys.add(key);
      }
    } while (cursor !== '0');
    return [...keys];
  }

  /**
   * The chunks of one document, in document order. See {@link VectorStore.listChunks}.
   *
   * Reads the hashes directly (`HMGET text metadata_json`) rather than going through `FT.SEARCH`.
   * Two reasons, and the second is the one that matters: the query language has no way to ask for
   * "every chunk of this document" — `id` is the key name, not an indexed field — and `FT.SEARCH`
   * caps at `LIMIT`, so paging a document through it would mean ordering by a field the index does
   * not hold. `chunkKeys` is the same enumeration {@link RedisVectorStore.remove} and
   * {@link RedisVectorStore.updateMetadata} already use, so "the chunks this returns" and "the chunks
   * a delete would take" cannot drift apart.
   *
   * It inherits that method's cost too: one keyspace `SCAN` per call. Acceptable here because this
   * is an inspection path (one document, on demand) and not something retrieval runs — but it is why
   * this must not be put on a hot path or called in a loop over a corpus.
   *
   * `embedding` is deliberately not fetched: it is by far the largest field on the hash and nothing
   * a caller reading text back can do with it.
   */
  async listChunks(documentId: string, options?: ListChunksOptions): Promise<StoredChunk[]> {
    const keys = await this.chunkKeys(documentId);
    const ordered = keys
      .map((key) => ({ key, id: key.slice(this.prefix.length) }))
      .map((entry) => ({ ...entry, index: chunkIndexOf(entry.id) }))
      .sort((a, b) => a.index - b.index);

    const offset = options?.offset ?? 0;
    const page =
      options?.limit === undefined
        ? ordered.slice(offset)
        : ordered.slice(offset, offset + options.limit);

    const chunks: StoredChunk[] = [];
    for (const entry of page) {
      const reply = await this.client.sendCommand(['HMGET', entry.key, 'text', 'metadata_json']);
      const fields = Array.isArray(reply) ? reply : [];
      const text = fields[0] === null || fields[0] === undefined ? undefined : toStr(fields[0]);
      if (text === undefined) {
        // The key was deleted between the SCAN and this read. Skip it rather than reporting a chunk
        // with empty text, which would read as "the chunker produced nothing here".
        continue;
      }
      const raw = fields[1] === null || fields[1] === undefined ? undefined : toStr(fields[1]);
      chunks.push({
        id: entry.id,
        index: entry.index,
        text,
        ...parseMetadata(raw),
      });
    }
    return chunks;
  }

  async listDocuments(filter?: Record<string, unknown>): Promise<IndexedDocument[]> {
    if (filterMatchesNothing(filter)) {
      return [];
    }
    const query = buildFilter(filter);
    const documents = new Map<string, IndexedDocument>();
    const batchSize = 1000;
    let offset = 0;
    for (;;) {
      // RETURN metadata_json (not NOCONTENT) so we can carry a representative chunk's metadata;
      // parseSearchReply already yields prefix-stripped ids + parsed metadata for both RESP2/RESP3.
      const reply = await this.client.sendCommand([
        'FT.SEARCH',
        this.index,
        query,
        'RETURN',
        '1',
        'metadata_json',
        'LIMIT',
        String(offset),
        String(batchSize),
        'DIALECT',
        '2',
      ]);
      const passages = parseSearchReply(reply, this.prefix);
      for (const passage of passages) {
        const id = documentIdOf(passage.id);
        if (!documents.has(id)) {
          documents.set(id, {
            id,
            ...(passage.metadata !== undefined ? { metadata: passage.metadata } : {}),
          });
        }
      }
      if (passages.length < batchSize) {
        break;
      }
      offset += batchSize;
    }
    return [...documents.values()];
  }

  /**
   * The id-only half of {@link RedisVectorStore.listDocuments}, served by `FT.SEARCH … NOCONTENT`:
   * RediSearch returns bare keys, so nothing carries `metadata_json` over the wire and nothing is
   * JSON-parsed. `listDocuments` has to parse one metadata blob per *chunk* — thousands of parses to
   * produce a few hundred ids it then throws the metadata away from — and this does none of it.
   *
   * The collapse to document ids still happens client-side. RediSearch can group server-side
   * (`FT.AGGREGATE … GROUPBY`), but only over an indexed *field*, and a chunk's document id lives in
   * its key, not in a field — deriving it would mean stamping one at write time, which is the
   * migration {@link RedisVectorStore.remove} explains this class refuses. Deduplicating a page of
   * keys in JS is free by comparison.
   */
  async listDocumentIds(filter?: Record<string, unknown>): Promise<string[]> {
    if (filterMatchesNothing(filter)) {
      return [];
    }
    const query = buildFilter(filter);
    const documents = new Set<string>();
    let offset = 0;
    for (;;) {
      const reply = await this.client.sendCommand([
        'FT.SEARCH',
        this.index,
        query,
        'NOCONTENT',
        'LIMIT',
        String(offset),
        String(SCAN_PAGE),
        'DIALECT',
        '2',
      ]);
      const keys = parseSearchKeys(reply);
      for (const key of keys) {
        documents.add(documentIdOf(stripPrefix(key, this.prefix)));
      }
      if (keys.length < SCAN_PAGE) {
        break;
      }
      offset += SCAN_PAGE;
    }
    return [...documents];
  }

  /**
   * Bulk deletion by document id — **one** keyspace scan for N documents, where N calls to
   * {@link RedisVectorStore.remove} would be N of them. The scan is `MATCH ${prefix}*`, so Redis still
   * filters to this store's own keys server-side; membership is then decided in JS against a `Set`,
   * which is what lets a single pass serve any number of ids.
   *
   * It deletes by key, exactly as `remove` does, so it is correct on chunks written by any version of
   * this library — there is no field it needs the corpus to already carry.
   */
  async removeMany(documentIds: string[]): Promise<void> {
    if (documentIds.length === 0) {
      return;
    }
    const wanted = new Set(documentIds);
    // A document may have been stored under its bare id (no `#n` suffix); those keys are exact and
    // need no scan to find, so seed them and let the scan add the chunked ones.
    let pending = documentIds.map((id) => `${this.prefix}${id}`);
    let cursor = '0';
    do {
      const reply = await this.client.sendCommand([
        'SCAN',
        cursor,
        'MATCH',
        `${escapeGlob(this.prefix)}*`,
        'COUNT',
        String(SCAN_PAGE),
      ]);
      const page = parseScanReply(reply);
      cursor = page.cursor;
      for (const key of page.keys) {
        if (wanted.has(documentIdOf(stripPrefix(key, this.prefix)))) {
          pending.push(key);
        }
      }
      if (pending.length >= DELETE_BATCH) {
        await this.client.sendCommand(['DEL', ...pending]);
        pending = [];
      }
    } while (cursor !== '0');
    if (pending.length > 0) {
      await this.client.sendCommand(['DEL', ...pending]);
    }
  }

  /**
   * Delete every chunk matching `filter`, via `FT.SEARCH … NOCONTENT` + `DEL` — no keyspace scan at
   * all, so dropping a collection costs one indexed query per page instead of one full pass per
   * document. Resolves the number of chunk keys actually deleted.
   *
   * The two refusals, in this order, before any query is issued:
   *
   * 1. **An empty filter object throws** {@link UnsafeRemovalError}. `buildFilter({})` is `*`, and `*`
   *    here would mean "delete the corpus" — far too destructive an outcome for the shape a filter
   *    degenerates to when it is built wrong.
   * 2. **An empty-array value deletes nothing** and resolves `0`. This is the package's deny primitive
   *    (an actor with no capability tokens), and it is the one that has to be gated *explicitly*: a
   *    plausible-looking "normalise the filter first" refactor that drops empty arrays turns a deny
   *    into `*` and wipes everything the deny existed to protect.
   *
   * Then one more, which is specific to RediSearch: every filter key must be a declared
   * `filterableFields` entry. `search` lets the engine reject an unknown field, which is fine for a
   * read; for a delete the check is worth making up front and by name.
   *
   * Deletion happens page by page, always re-querying from offset 0 — the rows just deleted are gone
   * from the index, so paging forward would skip their replacements. If a page comes back non-empty
   * but `DEL` reports nothing removed (keys expired between query and delete, or the index is stale),
   * the loop stops rather than spinning on results it can never consume.
   */
  async removeWhere(filter: Record<string, unknown>): Promise<number> {
    const keys = Object.keys(filter);
    if (keys.length === 0) {
      throw new UnsafeRemovalError(
        'empty-filter',
        'removeWhere() refuses an empty filter: it would delete every chunk in the index. ' +
          'Pass a filter that scopes the removal, or delete deliberately with ' +
          'removeMany(await store.listDocumentIds()).',
      );
    }
    const unindexed = keys.filter((key) => !this.filterableFields.includes(key));
    if (unindexed.length > 0) {
      const named = unindexed.map((key) => `"${key}"`).join(', ');
      const declared = this.filterableFields.join(', ') || 'none';
      throw new UnsafeRemovalError(
        'unindexed-field',
        `removeWhere() cannot scope on ${named}: not declared in this store's filterableFields (${declared}), so RediSearch has no TAG to match on.`,
      );
    }
    // THE guard. Removing it turns the deny primitive into an unfiltered delete — see the db spec's
    // "an empty-array filter deletes NOTHING" case, which exists to fail loudly if this ever goes.
    if (filterMatchesNothing(filter)) {
      return 0;
    }

    const query = buildFilter(filter);
    let removed = 0;
    for (;;) {
      const reply = await this.client.sendCommand([
        'FT.SEARCH',
        this.index,
        query,
        'NOCONTENT',
        'LIMIT',
        '0',
        String(DELETE_BATCH),
        'DIALECT',
        '2',
      ]);
      const page = parseSearchKeys(reply);
      if (page.length === 0) {
        break;
      }
      const deleted = Number(await this.client.sendCommand(['DEL', ...page]));
      if (!Number.isFinite(deleted) || deleted === 0) {
        break;
      }
      removed += deleted;
    }
    return removed;
  }

  /**
   * Count matching chunks with `FT.SEARCH … LIMIT 0 0` — RediSearch returns the total and no
   * documents, so the cost is the query, not the corpus. An empty-array filter value denies and
   * yields `0`, same as every other filtered path here.
   */
  async countChunks(filter?: Record<string, unknown>): Promise<number> {
    if (filterMatchesNothing(filter)) {
      return 0;
    }
    const reply = await this.client.sendCommand([
      'FT.SEARCH',
      this.index,
      buildFilter(filter),
      'NOCONTENT',
      'LIMIT',
      '0',
      '0',
      'DIALECT',
      '2',
    ]);
    return parseSearchTotal(reply);
  }

  async search(embedding: number[], options: VectorSearchOptions): Promise<Passage[]> {
    if (filterMatchesNothing(options.filter)) {
      return [];
    }
    const query = `${buildFilter(options.filter)}=>[KNN ${options.topK} @embedding $BLOB AS vector_score]`;
    const reply = await this.client.sendCommand([
      'FT.SEARCH',
      this.index,
      query,
      'PARAMS',
      '2',
      'BLOB',
      encodeVector(embedding),
      'RETURN',
      '4',
      'text',
      'source',
      'metadata_json',
      'vector_score',
      'SORTBY',
      'vector_score',
      'ASC',
      'DIALECT',
      '2',
      'LIMIT',
      '0',
      String(options.topK),
    ]);
    return parseSearchReply(reply, this.prefix);
  }

  /**
   * Lexical (BM25) search over the same index `search` uses — the {@link LexicalVectorStore} half of
   * hybrid retrieval, served by RediSearch's own keyword index rather than an in-process copy of the
   * corpus. `options.filter` is ANDed onto the text clause with the identical TAG semantics as
   * `search` (array = OR, empty array = deny), so a lexical hit can never escape a filter a vector
   * hit would have respected.
   *
   * A query with no searchable terms — empty, whitespace, or pure punctuation — returns `[]`. That is
   * deliberate: RediSearch's `*` would match the entire corpus, which is the opposite of what a
   * relevance query with nothing to be relevant to should do.
   */
  async searchText(query: string, options: VectorSearchOptions): Promise<Passage[]> {
    if (filterMatchesNothing(options.filter)) {
      return [];
    }
    const terms = tokenizeQuery(query);
    if (terms.length === 0) {
      return [];
    }
    const filterQuery = buildFilter(options.filter);
    const textQuery = `@text:(${terms.join('|')})`;
    const reply = await this.client.sendCommand([
      'FT.SEARCH',
      this.index,
      filterQuery === '*' ? textQuery : `(${filterQuery} ${textQuery})`,
      'SCORER',
      this.lexicalScorer,
      'WITHSCORES',
      'RETURN',
      '3',
      'text',
      'source',
      'metadata_json',
      'DIALECT',
      '2',
      'LIMIT',
      '0',
      String(options.topK),
    ]);
    return parseSearchReply(reply, this.prefix, 'lexical');
  }
}

/** Page size for `SCAN COUNT` and for the id-only `FT.SEARCH` pages. */
const SCAN_PAGE = 1000;

/** How many keys to hand a single `DEL`, and therefore how big a `removeWhere` page is. */
const DELETE_BATCH = 512;

/** Recover a chunk id from its Redis key. */
function stripPrefix(key: string, prefix: string): string {
  return key.startsWith(prefix) ? key.slice(prefix.length) : key;
}

/**
 * Parse the keys out of an `FT.SEARCH … NOCONTENT` reply, tolerating both wire shapes: the RESP2 array
 * `[total, key, key, …]` and the RESP3 object `{ total_results, results: [{ id }] }`. Keys come back
 * whole (prefix included) — callers strip it.
 */
function parseSearchKeys(reply: unknown): string[] {
  if (Array.isArray(reply)) {
    return reply.slice(1).map(toStr);
  }
  if (typeof reply === 'object' && reply !== null && 'results' in reply) {
    const results = (reply as { results: unknown }).results;
    return Array.isArray(results) ? results.map(readId) : [];
  }
  return [];
}

/**
 * Parse the match count out of an `FT.SEARCH … LIMIT 0 0` reply — element 0 in RESP2, `total_results`
 * in the RESP3 object. An unrecognised shape counts as 0 rather than `NaN`, so a caller comparing
 * against a threshold can't be handed something that fails every comparison silently.
 */
function parseSearchTotal(reply: unknown): number {
  if (Array.isArray(reply)) {
    const total = Number(toStr(reply[0]));
    return Number.isFinite(total) ? total : 0;
  }
  if (typeof reply === 'object' && reply !== null && 'total_results' in reply) {
    const total = Number((reply as { total_results: unknown }).total_results);
    return Number.isFinite(total) ? total : 0;
  }
  return 0;
}

/** One attribute as the live index reports it — enough to spot the drift that matters. */
interface IndexAttribute {
  /** `TEXT` / `TAG` / `VECTOR`. */
  type: string;
  /** `VECTOR` fields only: the width the index was created with. */
  dimensions?: number;
}

/**
 * Parse `FT.INFO`'s `attributes` into `attribute name → { type, dimensions }`, tolerating both wire
 * shapes exactly like {@link parseSearchReply} does: the RESP2 flat key/value array (whose attributes
 * are themselves flat key/value arrays) and node-redis's RESP3 object (attributes as objects).
 * Unknown shapes yield an empty map, which callers read as "can't tell" rather than "nothing there".
 */
function parseIndexAttributes(reply: unknown): Map<string, IndexAttribute> {
  const attributes = new Map<string, IndexAttribute>();
  for (const entry of readInfoField(reply, 'attributes')) {
    const fields = readKeyValues(entry);
    const name = fields.attribute ?? fields.identifier;
    if (name === undefined) {
      continue;
    }
    const dim = Number(fields.dim);
    attributes.set(name, {
      type: (fields.type ?? '').toUpperCase(),
      ...(fields.dim !== undefined && Number.isFinite(dim) ? { dimensions: dim } : {}),
    });
  }
  return attributes;
}

/** Read one top-level `FT.INFO` field as an array, from either the RESP2 pair-array or RESP3 object. */
function readInfoField(reply: unknown, key: string): unknown[] {
  if (Array.isArray(reply)) {
    for (let index = 0; index + 1 < reply.length; index += 2) {
      if (toStr(reply[index]) === key) {
        const value = reply[index + 1];
        return Array.isArray(value) ? value : [];
      }
    }
    return [];
  }
  if (typeof reply === 'object' && reply !== null && key in reply) {
    const value = (reply as Record<string, unknown>)[key];
    return Array.isArray(value) ? value : [];
  }
  return [];
}

/** Flatten one attribute entry (RESP2 pair-array or RESP3 object) into lower-cased string fields. */
function readKeyValues(entry: unknown): Record<string, string | undefined> {
  const fields: Record<string, string | undefined> = {};
  if (Array.isArray(entry)) {
    for (let index = 0; index + 1 < entry.length; index += 2) {
      fields[toStr(entry[index]).toLowerCase()] = toStr(entry[index + 1]);
    }
    return fields;
  }
  if (typeof entry === 'object' && entry !== null) {
    for (const [key, value] of Object.entries(entry)) {
      fields[key.toLowerCase()] = toStr(value);
    }
  }
  return fields;
}

/** RediSearch expects a little-endian FLOAT32 buffer for the query/stored vector. */
function encodeVector(embedding: number[]): Buffer {
  return Buffer.from(new Float32Array(embedding).buffer);
}

/**
 * `*` for no filter, else an AND of TAG clauses. A scalar value is an exact tag match
 * (`@meta_owner:{u1}`); an **array** value is a TAG alternation — match-any / OR
 * (`@meta_audience:{public|role\:ADMIN}`), the capability-ACL primitive. RediSearch TAG fields are
 * multi-valued per document, so this also matches documents carrying several of the tags.
 */
function buildFilter(filter?: Record<string, unknown>): string {
  if (filter === undefined || Object.keys(filter).length === 0) {
    return '*';
  }
  const clauses = Object.entries(filter).map(([key, value]) => {
    const values = Array.isArray(value) ? value : [value];
    const alternation = values.map((entry) => escapeTag(String(entry))).join('|');
    return `@meta_${key}:{${alternation}}`;
  });
  return `(${clauses.join(' ')})`;
}

/**
 * Reduce a raw user query to RediSearch query *terms*, the union of which becomes the text clause.
 *
 * This is the escaping story for the text leg, and it escapes by **construction** rather than by
 * quoting: a term is kept only as a run of letters, digits and `_`, so nothing that could carry
 * meaning in RediSearch's query language — `@ { } | ( ) * ~ - " ' : ; , => %` and friends — can
 * survive into the emitted query. A query cannot therefore add a clause, negate one, open a field
 * selector, or widen the filter it is ANDed with. (Escaping each punctuation character instead, as
 * {@link escapeTag} does for TAG values, would be safe but *lossy*: RediSearch's own tokenizer split
 * the indexed text on that same punctuation, so an escaped `hello\-world` term matches nothing.)
 *
 * Unicode letters and digits are kept — stripping to ASCII would silently make non-English corpora
 * unsearchable. Since `\p{L}`/`\p{N}` contain no RediSearch metacharacters, keeping them is safe.
 */
function tokenizeQuery(query: string): string[] {
  return query.match(/[\p{L}\p{N}_]+/gu) ?? [];
}

/**
 * Encode one metadata value as the `meta_<field>` hash field RediSearch indexes as a TAG. An **array**
 * becomes a multi-valued TAG (comma-separated, RediSearch's default separator) so a document can
 * carry several capability tokens — which is also why individual values must not contain commas.
 *
 * Shared by `upsert` and `updateMetadata` on purpose: they write the same field, and the day the two
 * encode it differently is the day a patched chunk stops matching a filter a freshly-ingested one
 * matches, for a value that looks identical in `metadata_json`.
 */
function encodeTag(value: unknown): string {
  return Array.isArray(value) ? value.map(String).join(',') : String(value);
}

/** Escape RediSearch TAG punctuation so an id/tenant value matches literally. */
function escapeTag(value: string): string {
  return value.replace(/[^a-zA-Z0-9_]/g, (char) => `\\${char}`);
}

/** Escape `SCAN MATCH` glob metacharacters so a document id matches its chunk keys literally. */
function escapeGlob(value: string): string {
  return value.replace(/[*?[\]\\]/g, (char) => `\\${char}`);
}

/**
 * Parse a `SCAN` reply into `{ cursor, keys }`, tolerating both wire shapes: the RESP2 array
 * `[cursor, [key, …]]` and node-redis's RESP3 object `{ cursor, keys }`.
 */
function parseScanReply(reply: unknown): { cursor: string; keys: string[] } {
  if (Array.isArray(reply) && reply.length >= 2) {
    const rawKeys = reply[1];
    return {
      cursor: toStr(reply[0]),
      keys: Array.isArray(rawKeys) ? rawKeys.map(toStr) : [],
    };
  }
  if (typeof reply === 'object' && reply !== null && 'cursor' in reply && 'keys' in reply) {
    const { cursor, keys } = reply as { cursor: unknown; keys: unknown };
    return {
      cursor: toStr(cursor),
      keys: Array.isArray(keys) ? keys.map(toStr) : [],
    };
  }
  return { cursor: '0', keys: [] };
}

function toStr(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  return Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
}

/**
 * Which leg produced the reply, and therefore where a passage's `score` comes from:
 *
 * - `vector` — the KNN query. Score is the returned `vector_score` **distance**, turned into a
 *   cosine similarity by `1 - distance`. Two array elements per result (`key`, `fields`).
 * - `lexical` — the `WITHSCORES` text query. The engine's BM25 relevance is already a
 *   bigger-is-better score, and it arrives *inline*: three array elements per result
 *   (`key`, `score`, `fields`), which is why the stride is not a constant.
 */
type ScoreSource = 'vector' | 'lexical';

/**
 * Parse an `FT.SEARCH` reply into passages, tolerating both wire shapes: the RESP2 array
 * `[total, key, [f, v, …], …]` (ioredis / node-redis RESP2) and the RESP3 object
 * `{ results: [{ id, extra_attributes: { … } }] }` (node-redis's default). The `prefix` is stripped
 * back off the key to recover the chunk id; `scoreSource` selects the scoring convention.
 */
function parseSearchReply(
  reply: unknown,
  prefix: string,
  scoreSource: ScoreSource = 'vector',
): Passage[] {
  const stride = scoreSource === 'lexical' ? 3 : 2;
  if (Array.isArray(reply)) {
    const passages: Passage[] = [];
    for (let index = 1; index + stride - 1 < reply.length; index += stride) {
      const rawFields = reply[index + stride - 1];
      if (Array.isArray(rawFields)) {
        const attrs: Record<string, string> = {};
        for (let field = 0; field + 1 < rawFields.length; field += 2) {
          attrs[toStr(rawFields[field])] = toStr(rawFields[field + 1]);
        }
        const inlineScore = scoreSource === 'lexical' ? toStr(reply[index + 1]) : undefined;
        passages.push(toPassage(toStr(reply[index]), attrs, prefix, scoreSource, inlineScore));
      }
    }
    return passages;
  }
  if (typeof reply === 'object' && reply !== null && 'results' in reply) {
    const results = (reply as { results: unknown }).results;
    if (Array.isArray(results)) {
      return results.map((result) =>
        toPassage(
          readId(result),
          readAttributes(result),
          prefix,
          scoreSource,
          scoreSource === 'lexical' ? readScore(result) : undefined,
        ),
      );
    }
  }
  return [];
}

/** RESP3 `WITHSCORES` puts the relevance score on the result object rather than inline in the array. */
function readScore(result: unknown): string | undefined {
  if (typeof result === 'object' && result !== null && 'score' in result) {
    return toStr((result as { score: unknown }).score);
  }
  return undefined;
}

function readId(result: unknown): string {
  if (typeof result === 'object' && result !== null && 'id' in result) {
    return toStr((result as { id: unknown }).id);
  }
  return '';
}

function readAttributes(result: unknown): Record<string, string> {
  const attrs: Record<string, string> = {};
  if (typeof result === 'object' && result !== null && 'extra_attributes' in result) {
    const raw = (result as { extra_attributes: unknown }).extra_attributes;
    if (typeof raw === 'object' && raw !== null) {
      for (const [key, value] of Object.entries(raw)) {
        attrs[key] = toStr(value);
      }
    }
  }
  return attrs;
}

function toPassage(
  rawId: string,
  attrs: Record<string, string>,
  prefix: string,
  scoreSource: ScoreSource = 'vector',
  inlineScore?: string,
): Passage {
  const score =
    scoreSource === 'lexical' ? Number(inlineScore ?? '0') : 1 - Number(attrs.vector_score ?? '1');
  const source = attrs.source;
  return {
    id: rawId.startsWith(prefix) ? rawId.slice(prefix.length) : rawId,
    text: attrs.text ?? '',
    score: Number.isFinite(score) ? score : 0,
    ...(source !== undefined ? { source } : {}),
    ...parseMetadata(attrs.metadata_json),
  };
}

function parseMetadata(raw: string | undefined): { metadata?: Record<string, unknown> } {
  if (raw === undefined) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null) {
      return { metadata: parsed as Record<string, unknown> };
    }
  } catch {
    // not JSON — no metadata
  }
  return {};
}
