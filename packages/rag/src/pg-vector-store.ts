import type { Passage } from '@dudousxd/nestjs-agent-core';
import type { VectorRecord, VectorSearchOptions, VectorStore } from './vector-store.js';

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
    await this.client.query(`DELETE FROM ${this.table} WHERE id = $1 OR id LIKE $2 ESCAPE '\\'`, [
      documentId,
      `${escapeLike(documentId)}#%`,
    ]);
  }

  async search(embedding: number[], options: VectorSearchOptions): Promise<Passage[]> {
    const vector = toVectorLiteral(embedding);
    const hasFilter = options.filter !== undefined && Object.keys(options.filter).length > 0;
    const rows = await this.client.query<PgRow>(
      `SELECT id, text, source, metadata, 1 - (embedding <=> $1::vector) AS score
       FROM ${this.table}
       ${hasFilter ? 'WHERE metadata @> $3::jsonb' : ''}
       ORDER BY embedding <=> $1::vector
       LIMIT $2`,
      hasFilter ? [vector, options.topK, JSON.stringify(options.filter)] : [vector, options.topK],
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

/** pgvector accepts a `'[1,2,3]'` text literal cast to `vector`. */
function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}

/** Escape `LIKE` wildcards so a document id containing `%`/`_`/`\` matches its chunks literally. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}
