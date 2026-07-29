import type { Passage } from '@dudousxd/nestjs-agent-core';
import { filterMatchesNothing } from './filter.js';
import { type MetadataPatch, isEmptyMetadataPatch, splitMetadataPatch } from './metadata-patch.js';
import type {
  IndexedDocument,
  VectorRecord,
  VectorSearchOptions,
  VectorStore,
} from './vector-store.js';
import { UnsafeRemovalError } from './vector-store.js';

/**
 * The minimal Postgres surface {@link PgVectorStore} needs — adapt your own `pg` / `postgres.js`
 * client to it, so this package pulls in NO driver (bring your own, like the store adapters take an
 * ORM handle and the Redis transport takes a client). `query` runs parameterized SQL (`$1,$2,…`) and
 * resolves the result rows.
 */
export interface PgClient {
  query<Row = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<Row[]>;
}

export interface PgVectorStoreOptions {
  /** Table name. Default `agent_rag_chunks`. */
  table?: string;
  /** Embedding width — must match your model (e.g. 1536 for text-embedding-3-small). Default 1536. */
  dimensions?: number;
}

/**
 * A pgvector-backed {@link VectorStore} — the production reference adapter. Cosine distance via the
 * `<=>` operator over an HNSW index; metadata in a `jsonb` column filtered with `@>`. Call
 * {@link PgVectorStore.ensureSchema} once at boot to create the extension, table, and index.
 *
 * This store does **not** implement the optional
 * {@link import('./vector-store.js').LexicalVectorStore} capability, unlike
 * {@link import('./redis-vector-store.js').RedisVectorStore}. That is a deliberate omission, not an
 * oversight: RediSearch already indexes the chunk text (the schema declares it `TEXT`), so BM25 is
 * free there, whereas the table below indexes nothing lexically — `text` is a plain column with no
 * `tsvector` and no GIN index. Adding one is not a transparent upgrade:
 *
 * - it is new DDL in `ensureSchema`, and `CREATE INDEX` (non-concurrently, as this method must, since
 *   `CONCURRENTLY` cannot run in a transaction) takes a write lock on an already-populated chunks
 *   table — a boot-time stall proportional to corpus size for every existing deployment;
 * - it forces a text-search-configuration choice (`english` vs `simple` vs …) that must match between
 *   the index expression and every query, or Postgres silently ignores the index and sequentially
 *   scans the corpus — a failure mode that stays *correct* while quietly getting slower with scale.
 *
 * Both want a migration a consumer runs and observes, not a side effect of upgrading the library. The
 * capability interface is open, so a `PgLexicalVectorStore` (or an option here, gated on an
 * explicitly-created index) can be added later without changing anything else.
 *
 * The enumeration and bulk-deletion methods {@link VectorStore} requires need nothing new here,
 * unlike the lexical capability above: enumeration and bulk deletion are `DISTINCT`, `= ANY($1)`, `DELETE … WHERE`
 * and `count(*)` over the table and index that already exist. No DDL, no boot-time lock, no migration.
 */
export class PgVectorStore implements VectorStore {
  private readonly table: string;
  private readonly dimensions: number;

  constructor(
    private readonly client: PgClient,
    options: PgVectorStoreOptions = {},
  ) {
    this.table = options.table ?? 'agent_rag_chunks';
    this.dimensions = options.dimensions ?? 1536;
  }

  /** Idempotent DDL: the `vector` extension, the chunks table, and the cosine HNSW index. */
  async ensureSchema(): Promise<void> {
    await this.client.query('CREATE EXTENSION IF NOT EXISTS vector');
    await this.client.query(
      `CREATE TABLE IF NOT EXISTS ${this.table} (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        source TEXT,
        metadata JSONB,
        embedding vector(${this.dimensions}) NOT NULL
      )`,
    );
    await this.client.query(
      `CREATE INDEX IF NOT EXISTS ${this.table}_embedding_idx
        ON ${this.table} USING hnsw (embedding vector_cosine_ops)`,
    );
  }

  async upsert(records: VectorRecord[]): Promise<void> {
    for (const record of records) {
      await this.client.query(
        `INSERT INTO ${this.table} (id, text, source, metadata, embedding)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET
           text = EXCLUDED.text,
           source = EXCLUDED.source,
           metadata = EXCLUDED.metadata,
           embedding = EXCLUDED.embedding`,
        [
          record.id,
          record.text,
          record.source ?? null,
          record.metadata !== undefined ? JSON.stringify(record.metadata) : null,
          toVectorLiteral(record.embedding),
        ],
      );
    }
  }

  async remove(documentId: string): Promise<void> {
    await this.client.query(`DELETE FROM ${this.table} WHERE ${DOCUMENT_ID_FROM_CHUNK} = $1`, [
      documentId,
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
    const { set, remove } = splitMetadataPatch(patch);
    const rows = await this.client.query<{ id: string }>(
      `UPDATE ${this.table}
          SET metadata = (COALESCE(metadata, '{}'::jsonb) || $2::jsonb) - $3::text[]
        WHERE ${DOCUMENT_ID_FROM_CHUNK} = $1
        RETURNING id`,
      [documentId, JSON.stringify(set), remove],
    );
    return rows.length;
  }

  async listDocuments(filter?: Record<string, unknown>): Promise<IndexedDocument[]> {
    const where = buildWhere(filter, 1);
    // DISTINCT ON collapses chunks to one row per document; all chunks share the doc's metadata.
    const rows = await this.client.query<{
      doc_id: string;
      metadata: Record<string, unknown> | null;
    }>(
      `SELECT DISTINCT ON (${DOCUMENT_ID_FROM_CHUNK}) ${DOCUMENT_ID_FROM_CHUNK} AS doc_id, metadata
       FROM ${this.table}
       ${where.sql}
       ORDER BY ${DOCUMENT_ID_FROM_CHUNK}`,
      where.params,
    );
    return rows.map((row) => ({
      id: row.doc_id,
      ...(row.metadata !== null ? { metadata: row.metadata } : {}),
    }));
  }

  /** {@link listDocuments} without the metadata: one `DISTINCT` over the derived document id. */
  async listDocumentIds(filter?: Record<string, unknown>): Promise<string[]> {
    if (filterMatchesNothing(filter)) {
      return [];
    }
    const where = buildWhere(filter, 1);
    const rows = await this.client.query<{ doc_id: string }>(
      `SELECT DISTINCT ${DOCUMENT_ID_FROM_CHUNK} AS doc_id
       FROM ${this.table}
       ${where.sql}
       ORDER BY doc_id`,
      where.params,
    );
    return rows.map((row) => row.doc_id);
  }

  /** N documents in one statement — the set-based form of {@link PgVectorStore.remove}. */
  async removeMany(documentIds: string[]): Promise<void> {
    if (documentIds.length === 0) {
      return;
    }
    await this.client.query(
      `DELETE FROM ${this.table} WHERE ${DOCUMENT_ID_FROM_CHUNK} = ANY($1::text[])`,
      [documentIds],
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
    const where = buildWhere(filter, 1);
    const rows = await this.client.query<{ id: string }>(
      `DELETE FROM ${this.table} ${where.sql} RETURNING id`,
      where.params,
    );
    return rows.length;
  }

  async countChunks(filter?: Record<string, unknown>): Promise<number> {
    if (filterMatchesNothing(filter)) {
      return 0;
    }
    const where = buildWhere(filter, 1);
    const rows = await this.client.query<{ count: number | string }>(
      `SELECT count(*)::int AS count FROM ${this.table} ${where.sql}`,
      where.params,
    );
    return Number(rows[0]?.count ?? 0);
  }

  async search(embedding: number[], options: VectorSearchOptions): Promise<Passage[]> {
    const vector = toVectorLiteral(embedding);
    // $1 = query vector, $2 = topK; metadata-filter params start at $3.
    const where = buildWhere(options.filter, 3);
    const rows = await this.client.query<PgRow>(
      `SELECT id, text, source, metadata, 1 - (embedding <=> $1::vector) AS score
       FROM ${this.table}
       ${where.sql}
       ORDER BY embedding <=> $1::vector
       LIMIT $2`,
      [vector, options.topK, ...where.params],
    );
    return rows.map((row) => ({
      id: row.id,
      text: row.text,
      score: Number(row.score),
      ...(row.source !== null ? { source: row.source } : {}),
      ...(row.metadata !== null ? { metadata: row.metadata } : {}),
    }));
  }
}

interface PgRow {
  id: string;
  text: string;
  source: string | null;
  metadata: Record<string, unknown> | null;
  score: number | string;
}

/**
 * Build the `WHERE` fragment for a metadata `filter`, with parameter placeholders numbered from
 * `startIndex`. Scalar values collapse into a single `@>` jsonb-containment check (exact-match, as
 * before). An **array** value is a **match-any** (OR / set membership) check via jsonb `?|`: the
 * record matches when its value for that key — scalar or array — shares an element with the filter
 * array. An empty array can never match (deny primitive). Keys are passed as parameters (`metadata->$k`)
 * so a caller-supplied metadata key can't inject SQL. Returns `{ sql: '', params: [] }` when there is
 * no filter, preserving the previous unfiltered query shape.
 */
function buildWhere(
  filter: Record<string, unknown> | undefined,
  startIndex: number,
): { sql: string; params: unknown[] } {
  if (filter === undefined || Object.keys(filter).length === 0) {
    return { sql: '', params: [] };
  }
  const clauses: string[] = [];
  const params: unknown[] = [];
  const scalar: Record<string, unknown> = {};
  let index = startIndex;
  for (const [key, value] of Object.entries(filter)) {
    if (Array.isArray(value)) {
      if (value.length === 0) {
        clauses.push('false');
        continue;
      }
      const keyParam = `$${index}`;
      params.push(key);
      index += 1;
      const arrParam = `$${index}`;
      params.push(value.map(String));
      index += 1;
      clauses.push(
        `(CASE WHEN jsonb_typeof(metadata->${keyParam}) = 'array' ` +
          `THEN metadata->${keyParam} ELSE jsonb_build_array(metadata->${keyParam}) END) ?| ${arrParam}::text[]`,
      );
    } else {
      scalar[key] = value;
    }
  }
  if (Object.keys(scalar).length > 0) {
    clauses.push(`metadata @> $${index}::jsonb`);
    params.push(JSON.stringify(scalar));
    index += 1;
  }
  return { sql: `WHERE ${clauses.join(' AND ')}`, params };
}

/**
 * SQL that collapses a chunk id (`${documentId}#<n>`) back to its source document id — the pgvector
 * mirror of {@link import('./vector-store.js').documentIdOf}. Shared by `remove` and
 * `listDocuments` so both key on the exact same definition of "chunk belongs to document".
 */
const DOCUMENT_ID_FROM_CHUNK = "regexp_replace(id, '#[0-9]+$', '')";

/** pgvector accepts a `'[1,2,3]'` text literal cast to `vector`. */
function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}
