import type { Passage } from '@dudousxd/nestjs-agent-core';
import { filterMatchesNothing } from './filter.js';
import {
  DEFAULT_STOP_WORDS,
  anyTermTsquery,
  hasSearchSyntax,
  keywordTerms,
} from './lexical-query.js';
import { type MetadataPatch, isEmptyMetadataPatch, splitMetadataPatch } from './metadata-patch.js';
import { type PgClient, type PgClientSource, toPgClient } from './pg-client.js';
import type { RetrievalDescriptor } from './retrieval-descriptor.js';
import type {
  IndexedDocument,
  LexicalVectorStore,
  ListChunksOptions,
  StoredChunk,
  VectorRecord,
  VectorSearchOptions,
  VectorStore,
} from './vector-store.js';
import { UnsafeRemovalError } from './vector-store.js';

export type { PgClient } from './pg-client.js';

/** Where the lexical leg of a {@link PgLexicalVectorStore} reads its `tsvector` from. */
export interface PgFullTextOptions {
  /**
   * Text-search configuration (`simple`, `english`, `portuguese`, …). Default `simple` — no stemming
   * or stop words, so it works for any language and matches exact terms, which is what the lexical
   * leg of a hybrid search is for. Must be the same configuration the index was built with, or
   * Postgres cannot use the index and scans the table (still correct, just slow).
   */
  config?: string;
  /**
   * A `tsvector` column you maintain yourself (typically `GENERATED ALWAYS AS (…) STORED` in a
   * migration, e.g. weighting a title above the body), with its own GIN index. When omitted the
   * store searches the expression `to_tsvector(config, text)`, and `ensureSchema` creates a GIN
   * expression index over exactly that.
   */
  column?: string;
  /**
   * Search natural-language questions by their meaningful terms (default `true`): the question's
   * stop words are dropped (see {@link PgFullTextOptions.stopWords}) and rows holding any remaining
   * term (at most 24) are ranked by the sum of the matched terms' IDF among those rows (BM25
   * without term frequencies), `ts_rank_cd` breaking ties; a question with explicit search syntax
   * (a quoted phrase, `-word`) is first tried as written. `false`: only `websearch_to_tsquery` on
   * the query as written (every word must appear).
   */
  anyTermFallback?: boolean;
  /**
   * Stop word lists dropped from questions, by language; only the list(s) with the most words in
   * the question apply, so a word that is a stop word in another language stays a term. Default
   * {@link DEFAULT_STOP_WORDS} (English, Portuguese, Spanish: Postgres' Snowball lists). `false`
   * keeps every word. With a language `config` (`english`) Postgres drops that language's stop
   * words as well.
   */
  stopWords?: Readonly<Record<string, ReadonlySet<string>>> | false;
}

export interface PgVectorStoreOptions {
  /** Table name. Default `agent_rag_chunks`. */
  table?: string;
  /**
   * Embedding width — must match your model (e.g. 1536 for text-embedding-3-small). Default 1536.
   *
   * Pass a **list** to let several models' vectors share one table (mixed dimensions, e.g. while
   * migrating from a 768-wide local model to a 1536-wide hosted one): the column becomes an untyped
   * `vector`, `ensureSchema` creates one *partial* HNSW index per listed width
   * (`((embedding::vector(n))) … WHERE vector_dims(embedding) = n`), and `search` only compares the
   * query against vectors of its own width, through that width's index. A query whose width is not
   * listed is still answered — exactly, by a sequential scan. Filter on the model as well (put it in
   * the chunk metadata) when two models share a width.
   */
  dimensions?: number | readonly number[];
  /**
   * Allow chunks with no embedding (`embedding: []` on upsert is stored as `NULL`): index text first
   * and embed later, or keep full-text-only chunks when there is no embedding model at all. The
   * vector leg skips them; the lexical leg of {@link PgLexicalVectorStore} still finds them. Default
   * `false` — the column stays `NOT NULL`. Only affects the DDL `ensureSchema` emits for a new table.
   */
  nullableEmbeddings?: boolean;
  /**
   * pgvector ≥ 0.8 iterative index scans for `search`: keep walking the HNSW graph until enough rows
   * pass the metadata filter, instead of returning fewer than `topK` when a selective filter (one
   * tenant of many) rejects most of the candidates the index produced. Applied with `SET LOCAL`, so
   * it needs a client with a `transaction` (a `pg` Pool, Drizzle or postgres.js all have one); it is
   * silently skipped on an older pgvector or a client without transactions. Default off.
   */
  iterativeScan?: 'strict_order' | 'relaxed_order';
  /** `hnsw.ef_search` for `search` (candidate list size; pgvector's default is 40). Needs a `transaction`. */
  efSearch?: number;
  /**
   * Rows per multi-row `INSERT … ON CONFLICT` statement in `upsert`. Default 100. Duplicate ids in
   * one `upsert` call collapse to the last occurrence (as the old row-by-row loop left them).
   */
  upsertBatchSize?: number;
}

/** The one byte Postgres `text`/`jsonb` columns refuse outright. */
const NUL_BYTE = String.fromCharCode(0);

/**
 * Strip the NUL byte (U+0000) out of a value before it reaches Postgres. `text` and `jsonb` columns
 * reject it outright — `invalid byte sequence for encoding "UTF8": 0x00` — and text extracted from
 * PDFs occasionally carries one even though other stores (Qdrant) accept it happily, so a chunk that
 * ingested fine elsewhere can fail here. Strings have the byte removed; arrays and **plain** objects
 * are walked recursively (object keys included, since a NUL can land in a metadata key too).
 *
 * "Plain" is deliberately narrow — `Object.getPrototypeOf(value)` must be `Object.prototype` or
 * `null` — so a `Date`, a `Buffer`, a class instance or any other non-plain object passes through
 * untouched rather than collapsing to `{}` via a blind `Object.entries`. Rebuilt objects go through
 * `Object.fromEntries` rather than assignment into a fresh `{}`, so a metadata key literally named
 * `__proto__` becomes an ordinary own property instead of silently repointing the result's prototype.
 */
export function stripNulBytes<T>(value: T): T {
  if (typeof value === 'string') {
    return (value.includes(NUL_BYTE) ? value.split(NUL_BYTE).join('') : value) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => stripNulBytes(item)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      return value;
    }
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        stripNulBytes(key),
        stripNulBytes(entry),
      ]),
    ) as unknown as T;
  }
  return value;
}

/**
 * A pgvector-backed {@link VectorStore} — the production reference adapter. Cosine distance via the
 * `<=>` operator over an HNSW index; metadata in a `jsonb` column filtered with `@>`. Call
 * {@link PgVectorStore.ensureSchema} once at boot to create the extension, table, and index — or copy
 * {@link PgVectorStore.schemaStatements} into a migration.
 *
 * The constructor takes a `pg` `Pool`, a Drizzle database, a `postgres.js` `sql`, or a hand-written
 * {@link PgClient} (see {@link toPgClient}).
 *
 * This class does **not** implement the optional
 * {@link import('./vector-store.js').LexicalVectorStore} capability; {@link PgLexicalVectorStore}
 * (below) does. The split is deliberate: lexical search over Postgres needs a GIN index, and a
 * store that silently gained `searchText` on upgrade would be picked up by every
 * `isLexicalVectorStore(store)` check and start sequentially scanning an unindexed chunks table:
 *
 * - it is new DDL, and `CREATE INDEX` (non-concurrently, as `ensureSchema` must, since
 *   `CONCURRENTLY` cannot run in a transaction) takes a write lock on an already-populated chunks
 *   table — a boot-time stall proportional to corpus size for every existing deployment;
 * - it forces a text-search-configuration choice (`english` vs `simple` vs …) that must match between
 *   the index expression and every query, or Postgres silently ignores the index and sequentially
 *   scans the corpus — a failure mode that stays *correct* while quietly getting slower with scale.
 *
 * So lexical search is something you opt into by constructing the subclass, with the index created
 * by a migration you run and watch (or by `ensureSchema`, on a table small enough not to care).
 *
 * The enumeration and bulk-deletion methods {@link VectorStore} requires need nothing new here,
 * unlike the lexical capability above: enumeration and bulk deletion are `DISTINCT`, `= ANY($1)`, `DELETE … WHERE`
 * and `count(*)` over the table and index that already exist. No DDL, no boot-time lock, no migration.
 *
 * Subclassing: every statement filters through {@link PgVectorStore.whereConditions}, so a subclass
 * can map an opaque filter onto its own columns (a tenant id, an ACL) in one place.
 */
export class PgVectorStore implements VectorStore {
  protected readonly client: PgClient;
  protected readonly table: string;
  /** The single width (fixed-dimension table), or `undefined` for a mixed-dimension table. */
  private readonly dimensions: number | undefined;
  /** The widths with a partial HNSW index, for a mixed-dimension table. */
  private readonly indexedDimensions: readonly number[];
  private readonly nullableEmbeddings: boolean;
  private readonly iterativeScan: PgVectorStoreOptions['iterativeScan'];
  private readonly efSearch: number | undefined;
  private readonly upsertBatchSize: number;
  private iterativeScanSupport: Promise<boolean> | undefined;

  constructor(client: PgClientSource, options: PgVectorStoreOptions = {}) {
    this.client = toPgClient(client);
    this.table = options.table ?? 'agent_rag_chunks';
    const dimensions = options.dimensions ?? 1536;
    if (typeof dimensions === 'number') {
      this.dimensions = dimensions;
      this.indexedDimensions = [];
    } else {
      for (const width of dimensions) {
        if (!Number.isInteger(width) || width <= 0) {
          throw new Error(`PgVectorStore: invalid embedding width ${String(width)}`);
        }
      }
      this.dimensions = undefined;
      this.indexedDimensions = [...new Set(dimensions)];
    }
    this.nullableEmbeddings = options.nullableEmbeddings ?? false;
    this.iterativeScan = options.iterativeScan;
    this.efSearch = options.efSearch;
    this.upsertBatchSize = Math.max(1, Math.floor(options.upsertBatchSize ?? 100));
  }

  /** Telemetry self-description — the table is the namespace a retrieval was served from. */
  describeRetrieval(): RetrievalDescriptor {
    return { store: 'pg', collection: this.table };
  }

  /**
   * The idempotent DDL {@link PgVectorStore.ensureSchema} runs, in order — for a migration instead
   * of a boot-time side effect. On a populated table, run the index statements `CONCURRENTLY` there.
   */
  schemaStatements(): string[] {
    const mixed = this.dimensions === undefined;
    const column = mixed ? 'vector' : `vector(${this.dimensions})`;
    const statements = [
      'CREATE EXTENSION IF NOT EXISTS vector',
      `CREATE TABLE IF NOT EXISTS ${this.table} (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        source TEXT,
        metadata JSONB,
        embedding ${column}${this.nullableEmbeddings ? '' : ' NOT NULL'}
      )`,
    ];
    if (mixed) {
      for (const width of this.indexedDimensions) {
        statements.push(
          `CREATE INDEX IF NOT EXISTS ${this.table}_embedding_${width}_idx
        ON ${this.table} USING hnsw ((embedding::vector(${width})) vector_cosine_ops)
        WHERE vector_dims(embedding) = ${width}`,
        );
      }
    } else {
      statements.push(
        `CREATE INDEX IF NOT EXISTS ${this.table}_embedding_idx
        ON ${this.table} USING hnsw (embedding vector_cosine_ops)`,
      );
    }
    return statements;
  }

  /** Idempotent DDL: the `vector` extension, the chunks table, and the cosine HNSW index(es). */
  async ensureSchema(): Promise<void> {
    for (const statement of this.schemaStatements()) {
      await this.client.query(statement);
    }
  }

  /**
   * Multi-row `INSERT … ON CONFLICT (id) DO UPDATE`, {@link PgVectorStoreOptions.upsertBatchSize}
   * rows per statement. An empty `embedding` is written as `NULL` (see
   * {@link PgVectorStoreOptions.nullableEmbeddings}).
   */
  async upsert(records: VectorRecord[]): Promise<void> {
    // Postgres rejects the NUL byte in text/jsonb — see stripNulBytes. The id is stripped before
    // de-duplication, so two ids that only differ by a NUL byte are the same row, as they'd be stored.
    const byId = new Map<string, VectorRecord>();
    for (const record of records) {
      const id = stripNulBytes(record.id);
      // Delete first so the surviving record takes the position of its LAST occurrence.
      byId.delete(id);
      byId.set(id, { ...record, id });
    }
    // One statement can't touch a row twice (`ON CONFLICT DO UPDATE command cannot affect row a
    // second time`), hence the de-duplication above: last write wins, as with the row-by-row loop.
    const unique = [...byId.values()];
    for (let start = 0; start < unique.length; start += this.upsertBatchSize) {
      const batch = unique.slice(start, start + this.upsertBatchSize);
      const params: unknown[] = [];
      const rows = batch.map((record) => {
        const text = stripNulBytes(record.text);
        const source = record.source !== undefined ? stripNulBytes(record.source) : undefined;
        const metadata = record.metadata !== undefined ? stripNulBytes(record.metadata) : undefined;
        const base = params.length;
        params.push(
          record.id,
          text,
          source ?? null,
          metadata !== undefined ? JSON.stringify(metadata) : null,
          record.embedding.length > 0 ? toVectorLiteral(record.embedding) : null,
        );
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}::jsonb, $${base + 5}::vector)`;
      });
      await this.client.query(
        `INSERT INTO ${this.table} (id, text, source, metadata, embedding)
         VALUES ${rows.join(', ')}
         ON CONFLICT (id) DO UPDATE SET
           text = EXCLUDED.text,
           source = EXCLUDED.source,
           metadata = EXCLUDED.metadata,
           embedding = EXCLUDED.embedding`,
        params,
      );
    }
  }

  async remove(documentId: string): Promise<void> {
    // Stripped so it matches the id `upsert` actually stored, and so a NUL-bearing id can't 0x00
    // the DELETE itself.
    await this.client.query(`DELETE FROM ${this.table} WHERE ${DOCUMENT_ID_FROM_CHUNK} = $1`, [
      stripNulBytes(documentId),
    ]);
  }

  /**
   * Rewrite a document's metadata without re-embedding it. See {@link VectorStore.updateMetadata}
   * for the semantics; here the whole thing is one statement, because jsonb already *is* the merge:
   * `||` is a shallow key-wise merge (right side wins, arrays replaced wholesale — precisely
   * {@link MetadataPatch}) and `- text[]` drops the keys the patch removed. `COALESCE` covers a chunk
   * ingested with no metadata at all, so a patch can create the object rather than no-op on `NULL`.
   *
   * Unlike RediSearch there is no second representation to keep in step — the `metadata` column is
   * both what `search` filters on and what it returns — so the correctness trap the Redis adapter has
   * to work for simply does not exist here. `RETURNING id` is what supplies the chunk count, since
   * {@link PgClient} is a rows-only surface with no `rowCount`.
   */
  async updateMetadata(documentId: string, patch: MetadataPatch): Promise<number> {
    if (isEmptyMetadataPatch(patch)) {
      return 0;
    }
    // Postgres rejects the NUL byte in text/jsonb — see stripNulBytes. `documentId` too, so it
    // matches the id `upsert` actually stored.
    const { set, remove } = splitMetadataPatch(stripNulBytes(patch));
    const rows = await this.client.query<{ id: string }>(
      `UPDATE ${this.table}
          SET metadata = (COALESCE(metadata, '{}'::jsonb) || $2::jsonb) - $3::text[]
        WHERE ${DOCUMENT_ID_FROM_CHUNK} = $1
        RETURNING id`,
      [stripNulBytes(documentId), JSON.stringify(set), remove],
    );
    return rows.length;
  }

  async listDocuments(filter?: Record<string, unknown>): Promise<IndexedDocument[]> {
    const params: unknown[] = [];
    const where = this.where(filter, params);
    // DISTINCT ON collapses chunks to one row per document; all chunks share the doc's metadata.
    const rows = await this.client.query<{
      doc_id: string;
      metadata: Record<string, unknown> | null;
    }>(
      `SELECT DISTINCT ON (${DOCUMENT_ID_FROM_CHUNK}) ${DOCUMENT_ID_FROM_CHUNK} AS doc_id, metadata
       FROM ${this.table}
       ${where}
       ORDER BY ${DOCUMENT_ID_FROM_CHUNK}`,
      params,
    );
    return rows.map((row) => ({
      id: row.doc_id,
      ...(row.metadata !== null ? { metadata: row.metadata } : {}),
    }));
  }

  /**
   * The chunks of one document, in document order. See {@link VectorStore.listChunks}.
   *
   * The order is computed from the id rather than stored: `#12` must sort after `#2`, which a plain
   * `ORDER BY id` gets wrong on every document past ten chunks because it compares text. So the
   * trailing number is extracted and cast to `int`, and a bare id (a single-chunk document, which
   * carries no `#n` suffix) collapses to `0` — the same rule `chunkIndexOf` applies in the other two
   * adapters.
   *
   * `embedding` is left out of the projection: it is the widest column in the table and useless to a
   * caller reading text back.
   */
  async listChunks(documentId: string, options?: ListChunksOptions): Promise<StoredChunk[]> {
    // Stripped so it matches the id `upsert` actually stored.
    const params: unknown[] = [stripNulBytes(documentId)];
    let sql = `SELECT id, ${CHUNK_INDEX_FROM_ID} AS chunk_index, text, metadata
       FROM ${this.table}
       WHERE ${DOCUMENT_ID_FROM_CHUNK} = $1
       ORDER BY chunk_index`;
    if (options?.limit !== undefined) {
      params.push(options.limit);
      sql += ` LIMIT $${params.length}`;
    }
    if (options?.offset !== undefined) {
      params.push(options.offset);
      sql += ` OFFSET $${params.length}`;
    }
    const rows = await this.client.query<{
      id: string;
      chunk_index: number;
      text: string;
      metadata: Record<string, unknown> | null;
    }>(sql, params);
    return rows.map((row) => ({
      id: row.id,
      index: Number(row.chunk_index),
      text: row.text,
      ...(row.metadata !== null ? { metadata: row.metadata } : {}),
    }));
  }

  /** {@link listDocuments} without the metadata: one `DISTINCT` over the derived document id. */
  async listDocumentIds(filter?: Record<string, unknown>): Promise<string[]> {
    if (filterMatchesNothing(filter)) {
      return [];
    }
    const params: unknown[] = [];
    const where = this.where(filter, params);
    const rows = await this.client.query<{ doc_id: string }>(
      `SELECT DISTINCT ${DOCUMENT_ID_FROM_CHUNK} AS doc_id
       FROM ${this.table}
       ${where}
       ORDER BY doc_id`,
      params,
    );
    return rows.map((row) => row.doc_id);
  }

  /** N documents in one statement — the set-based form of {@link PgVectorStore.remove}. */
  async removeMany(documentIds: string[]): Promise<void> {
    if (documentIds.length === 0) {
      return;
    }
    // Stripped so every id matches what `upsert` actually stored.
    await this.client.query(
      `DELETE FROM ${this.table} WHERE ${DOCUMENT_ID_FROM_CHUNK} = ANY($1::text[])`,
      [stripNulBytes(documentIds)],
    );
  }

  /**
   * See {@link VectorStore.removeWhere}: empty filter object throws, empty-array value
   * deletes nothing. The count comes from `RETURNING id` rather than a driver-specific `rowCount`,
   * because {@link PgClient} is deliberately just "run SQL, get rows".
   */
  async removeWhere(filter: Record<string, unknown>): Promise<number> {
    if (Object.keys(filter).length === 0) {
      throw new UnsafeRemovalError(
        'empty-filter',
        'removeWhere() refuses an empty filter: it would delete every chunk in the table. ' +
          'Pass a filter that scopes the removal, or delete deliberately with ' +
          'removeMany(await store.listDocumentIds()).',
      );
    }
    // Redundant with buildWhere's `false` clause, and stated anyway — the deny primitive should be
    // visible at the destructive call site, not one indirection away.
    if (filterMatchesNothing(filter)) {
      return 0;
    }
    const params: unknown[] = [];
    const where = this.where(filter, params);
    const rows = await this.client.query<{ id: string }>(
      `DELETE FROM ${this.table} ${where} RETURNING id`,
      params,
    );
    return rows.length;
  }

  async countChunks(filter?: Record<string, unknown>): Promise<number> {
    if (filterMatchesNothing(filter)) {
      return 0;
    }
    const params: unknown[] = [];
    const where = this.where(filter, params);
    const rows = await this.client.query<{ count: number | string }>(
      `SELECT count(*)::int AS count FROM ${this.table} ${where}`,
      params,
    );
    return Number(rows[0]?.count ?? 0);
  }

  /**
   * Cosine similarity, nearest first. On a mixed-dimension table only vectors as wide as the query
   * are compared (through that width's partial index when it has one); chunks without an embedding
   * are never returned.
   */
  async search(embedding: number[], options: VectorSearchOptions): Promise<Passage[]> {
    if (embedding.length === 0) {
      return [];
    }
    // $1 = query vector, $2 = topK; metadata-filter params start at $3.
    const params: unknown[] = [toVectorLiteral(embedding), options.topK];
    const conditions = this.whereConditions(options.filter, params);
    let vectorType = 'vector';
    if (this.dimensions === undefined) {
      const width = embedding.length;
      if (this.indexedDimensions.includes(width)) {
        vectorType = `vector(${width})`;
      }
      conditions.push('embedding IS NOT NULL', `vector_dims(embedding) = ${width}`);
    } else if (this.nullableEmbeddings) {
      conditions.push('embedding IS NOT NULL');
    }
    // A fixed-width table keeps the exact expression its index was built on (`embedding`); a
    // mixed one casts both sides so the planner can match the per-width partial index.
    const column = vectorType === 'vector' ? 'embedding' : `(embedding::${vectorType})`;
    const sql = `SELECT id, text, source, metadata, 1 - (${column} <=> $1::${vectorType}) AS score
       FROM ${this.table}
       ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}
       ORDER BY ${column} <=> $1::${vectorType}
       LIMIT $2`;
    const rows = await this.withSearchSettings((client) => client.query<PgRow>(sql, params));
    return rows.map(toPassage);
  }

  /**
   * The SQL conditions (ANDed) a metadata `filter` compiles to, appending their bindings to `params`
   * (placeholders are numbered after what `params` already holds). Every statement that takes a
   * filter goes through here, so a subclass that maps the filter onto its own columns — a tenant id,
   * an access list — overrides this one method. Return `['false']` to deny.
   */
  protected whereConditions(
    filter: Record<string, unknown> | undefined,
    params: unknown[],
  ): string[] {
    return buildWhere(filter, params);
  }

  private where(filter: Record<string, unknown> | undefined, params: unknown[]): string {
    const conditions = this.whereConditions(filter, params);
    return conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  }

  /** Run a read with the configured HNSW settings `SET LOCAL` in one transaction, when possible. */
  private async withSearchSettings<T>(read: (client: PgClient) => Promise<T>): Promise<T> {
    const transaction = this.client.transaction?.bind(this.client);
    if (transaction === undefined) {
      return read(this.client);
    }
    const iterative = this.iterativeScan !== undefined && (await this.supportsIterativeScan());
    if (!iterative && this.efSearch === undefined) {
      return read(this.client);
    }
    return transaction(async (tx) => {
      if (iterative) {
        await tx.query(`SELECT set_config('hnsw.iterative_scan', $1, true)`, [this.iterativeScan]);
      }
      if (this.efSearch !== undefined) {
        await tx.query(`SELECT set_config('hnsw.ef_search', $1, true)`, [String(this.efSearch)]);
      }
      return read(tx);
    });
  }

  /** `hnsw.iterative_scan` exists from pgvector 0.8.0; setting it on an older one is an error. */
  private supportsIterativeScan(): Promise<boolean> {
    this.iterativeScanSupport ??= this.client
      .query<{ extversion: string }>(`SELECT extversion FROM pg_extension WHERE extname = 'vector'`)
      .then((rows) => {
        const [major = 0, minor = 0] = (rows[0]?.extversion ?? '0.0').split('.').map(Number);
        return major > 0 || minor >= 8;
      })
      .catch(() => false);
    return this.iterativeScanSupport;
  }
}

/**
 * {@link PgVectorStore} plus Postgres full-text search: a {@link LexicalVectorStore}, so
 * `LexicalRetriever` and `HybridRetriever` work on Postgres exactly as on RediSearch — the dense leg
 * over pgvector, the lexical leg over a `tsvector`, both on the same rows and ids.
 *
 * A question is searched by its meaningful terms: its stop words dropped, rows holding any remaining
 * term ranked by IDF-weighted coverage, `ts_rank_cd` (cover density) breaking ties (see
 * {@link PgFullTextOptions.anyTermFallback}); explicit syntax (quoted phrases, `-exclusions`) goes
 * through `websearch_to_tsquery` first.
 *
 * The `tsvector` is either a column you own ({@link PgFullTextOptions.column}) or the expression
 * `to_tsvector(config, text)`, for which {@link PgVectorStore.schemaStatements} adds a GIN
 * expression index. See {@link PgVectorStore} for why that index belongs in a migration on a
 * populated table.
 */
export class PgLexicalVectorStore extends PgVectorStore implements LexicalVectorStore {
  private readonly tsConfig: string;
  private readonly tsColumn: string | undefined;
  private readonly anyTermFallback: boolean;
  private readonly stopWords: Readonly<Record<string, ReadonlySet<string>>>;

  constructor(
    client: PgClientSource,
    options: PgVectorStoreOptions & { fullText?: PgFullTextOptions } = {},
  ) {
    super(client, options);
    const config = options.fullText?.config ?? 'simple';
    if (!SQL_IDENTIFIER.test(config)) {
      throw new Error(`PgLexicalVectorStore: invalid text search configuration "${config}"`);
    }
    const column = options.fullText?.column;
    if (column !== undefined && !SQL_IDENTIFIER.test(column)) {
      throw new Error(`PgLexicalVectorStore: invalid tsvector column "${column}"`);
    }
    this.tsConfig = config;
    this.tsColumn = column;
    this.anyTermFallback = options.fullText?.anyTermFallback ?? true;
    const stopWords = options.fullText?.stopWords;
    this.stopWords = stopWords === false ? {} : (stopWords ?? DEFAULT_STOP_WORDS);
  }

  override schemaStatements(): string[] {
    const statements = super.schemaStatements();
    if (this.tsColumn === undefined) {
      statements.push(
        `CREATE INDEX IF NOT EXISTS ${this.table}_text_tsv_idx
        ON ${this.table} USING gin (${this.tsvector()})`,
      );
    }
    return statements;
  }

  async searchText(query: string, options: VectorSearchOptions): Promise<Passage[]> {
    if (filterMatchesNothing(options.filter) || query.trim() === '') {
      return [];
    }
    if (!this.anyTermFallback || hasSearchSyntax(query)) {
      const strict = await this.runTextSearch(query, options);
      if (strict.length > 0 || !this.anyTermFallback) {
        return strict;
      }
    }
    const terms = keywordTerms(query, 24, this.stopWords);
    return terms.length === 0 ? [] : this.runRankedTermSearch(terms, options);
  }

  /** `websearch_to_tsquery` on the query as written: every word, quoted phrases, `-exclusions`. */
  private async runTextSearch(query: string, options: VectorSearchOptions): Promise<Passage[]> {
    const tsquery = `websearch_to_tsquery('${this.tsConfig}', $1)`;
    // $1 = query, $2 = topK; metadata-filter params start at $3.
    const params: unknown[] = [query, options.topK];
    const conditions = [
      `${this.tsvector()} @@ ${tsquery}`,
      ...this.whereConditions(options.filter, params),
    ];
    const rows = await this.client.query<PgRow>(
      `SELECT id, text, source, metadata, ts_rank_cd(${this.tsvector()}, ${tsquery}) AS score
       FROM ${this.table}
       WHERE ${conditions.join(' AND ')}
       ORDER BY score DESC, id
       LIMIT $2`,
      params,
    );
    return rows.map(toPassage);
  }

  /**
   * Rows holding any of `terms`, ranked by the sum of the matched terms' IDF among those rows,
   * `ln(1 + (N - df + 0.5) / (df + 0.5))`, then `ts_rank_cd`. Each (row, term) match is evaluated
   * once, and `ts_rank_cd` only for the rows ranked within `topK` (ties included): a question full
   * of common words can match most of the table.
   */
  private async runRankedTermSearch(
    terms: string[],
    options: VectorSearchOptions,
  ): Promise<Passage[]> {
    const any = `to_tsquery('${this.tsConfig}', $1)`;
    // $1 = any-term tsquery, $2 = topK, $3 = terms; metadata-filter params start at $4.
    // Terms are letters/digits only, so quoting each one is enough to make it a literal lexeme.
    const params: unknown[] = [anyTermTsquery(terms), options.topK, terms];
    const conditions = [
      `${this.tsvector()} @@ ${any}`,
      ...this.whereConditions(options.filter, params),
    ];
    const rows = await this.client.query<PgRow>(
      `WITH __terms AS (
         SELECT DISTINCT to_tsquery('${this.tsConfig}', quote_literal(t)) AS q
         FROM unnest($3::text[]) AS t
       ), __cand AS MATERIALIZED (
         SELECT id, text, source, metadata, ${this.tsvector()} AS __tsv
         FROM ${this.table}
         WHERE ${conditions.join(' AND ')}
       ), __hits AS MATERIALIZED (
         SELECT __cand.id AS __id, __terms.q FROM __cand JOIN __terms ON __cand.__tsv @@ __terms.q
       ), __idf AS (
         SELECT q, ln(1 + ((SELECT count(*) FROM __cand) - count(*) + 0.5) / (count(*) + 0.5)) AS w
         FROM __hits GROUP BY q
       ), __scored AS (
         SELECT __hits.__id, sum(__idf.w) AS s, rank() OVER (ORDER BY sum(__idf.w) DESC) AS r
         FROM __hits JOIN __idf USING (q) GROUP BY __hits.__id
       )
       SELECT __cand.id, __cand.text, __cand.source, __cand.metadata,
              __scored.s + ts_rank_cd(__cand.__tsv, ${any}, 32) AS score
       FROM __scored JOIN __cand ON __cand.id = __scored.__id
       WHERE __scored.r <= $2
       ORDER BY __scored.s DESC, ts_rank_cd(__cand.__tsv, ${any}, 32) DESC, __cand.id
       LIMIT $2`,
      params,
    );
    return rows.map(toPassage);
  }

  /** Must be character-for-character the index expression, or the planner won't use the index. */
  private tsvector(): string {
    return this.tsColumn ?? `to_tsvector('${this.tsConfig}'::regconfig, text)`;
  }
}

const SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;

interface PgRow {
  id: string;
  text: string;
  source: string | null;
  metadata: Record<string, unknown> | null;
  score: number | string;
}

function toPassage(row: PgRow): Passage {
  return {
    id: row.id,
    text: row.text,
    score: Number(row.score),
    ...(row.source !== null ? { source: row.source } : {}),
    ...(row.metadata !== null ? { metadata: row.metadata } : {}),
  };
}

/**
 * Build the conditions for a metadata `filter`, appending their bindings to `params` (placeholders
 * continue from `params.length`). Scalar values collapse into a single `@>` jsonb-containment check
 * (exact-match, as before). An **array** value is a **match-any** (OR / set membership) check via
 * jsonb `?|`: the record matches when its value for that key — scalar or array — shares an element
 * with the filter array. An empty array can never match (deny primitive). Keys are passed as
 * parameters (`metadata->$k`) so a caller-supplied metadata key can't inject SQL. Returns `[]` when
 * there is no filter, preserving the previous unfiltered query shape.
 *
 * The filter is run through {@link stripNulBytes} up front: both the keys (bound as `$k` params) and
 * the scalar/array values end up as query bindings, and a caller-supplied filter is exactly as
 * capable of carrying a NUL byte as the text it is filtering.
 */
export function buildWhere(
  filter: Record<string, unknown> | undefined,
  params: unknown[],
): string[] {
  if (filter === undefined || Object.keys(filter).length === 0) {
    return [];
  }
  const stripped = stripNulBytes(filter);
  const clauses: string[] = [];
  const scalar: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(stripped)) {
    if (Array.isArray(value)) {
      if (value.length === 0) {
        clauses.push('false');
        continue;
      }
      params.push(key);
      const keyParam = `$${params.length}`;
      params.push(value.map(String));
      const arrParam = `$${params.length}`;
      clauses.push(
        `(CASE WHEN jsonb_typeof(metadata->${keyParam}) = 'array' ` +
          `THEN metadata->${keyParam} ELSE jsonb_build_array(metadata->${keyParam}) END) ?| ${arrParam}::text[]`,
      );
    } else {
      scalar[key] = value;
    }
  }
  if (Object.keys(scalar).length > 0) {
    params.push(JSON.stringify(scalar));
    clauses.push(`metadata @> $${params.length}::jsonb`);
  }
  return clauses;
}

/**
 * SQL that collapses a chunk id (`${documentId}#<n>`) back to its source document id — the pgvector
 * mirror of {@link import('./vector-store.js').documentIdOf}. Shared by `remove` and
 * `listDocuments` so both key on the exact same definition of "chunk belongs to document".
 */
const DOCUMENT_ID_FROM_CHUNK = "regexp_replace(id, '#[0-9]+$', '')";

/** The `n` of `…#<n>` as an integer, so chunks sort numerically; a bare id (no suffix) is `0`. */
const CHUNK_INDEX_FROM_ID = "COALESCE((substring(id from '#([0-9]+)$'))::int, 0)";

/** pgvector accepts a `'[1,2,3]'` text literal cast to `vector`. */
function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}
