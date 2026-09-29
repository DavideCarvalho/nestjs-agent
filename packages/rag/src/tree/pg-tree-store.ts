import { type PgClient, type PgClientSource, toPgClient } from '../pg-client.js';
import { buildWhere, stripNulBytes } from '../pg-vector-store.js';
import { type DocumentTreeHeader, type DocumentTreeStore, headerOf } from './store.js';
import type { DocumentTree, TreeUnit } from './types.js';

export interface PgDocumentTreeStoreOptions {
  /** Trees table. Default `agent_rag_trees`. */
  table?: string;
  /** Units (page/section text) table. Default `${table}_units`, i.e. `agent_rag_trees_units`. */
  unitsTable?: string;
  /** Unit rows per multi-row `INSERT`. Default 200. */
  insertBatchSize?: number;
}

interface TreeRow {
  document_id: string;
  title: string | null;
  description: string | null;
  structure: DocumentTree['structure'];
  fingerprint: string;
  unit_count: number;
  source: string | null;
  metadata: Record<string, unknown> | string | null;
  tree?: DocumentTree | string;
  built_at: Date | string;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;

function json<T>(value: T | string | null | undefined): T | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  return typeof value === 'string' ? (JSON.parse(value) as T) : value;
}

/**
 * A Postgres {@link DocumentTreeStore}: one row per tree (the header columns, `metadata` as `jsonb`
 * for filtering, the nodes as `jsonb`) and one row per unit of text. Filters compile to the same SQL
 * as `PgVectorStore`'s — scalar `@>`, array match-any, empty array denies — so the filter you pass
 * the vector store works here unchanged.
 *
 * Takes the same clients as `PgVectorStore`: a `pg` `Pool`, a Drizzle database, a `postgres.js`
 * `sql`, or a {@link PgClient}. Call {@link PgDocumentTreeStore.ensureSchema} at boot, or copy
 * {@link PgDocumentTreeStore.schemaStatements} into a migration. Needs no extension.
 *
 * Subclassing: every filtered statement goes through {@link PgDocumentTreeStore.whereConditions}, like
 * `PgVectorStore.whereConditions`, so a subclass can map a filter onto its own columns.
 */
export class PgDocumentTreeStore implements DocumentTreeStore {
  protected readonly client: PgClient;
  protected readonly table: string;
  protected readonly unitsTable: string;
  private readonly insertBatchSize: number;

  constructor(client: PgClientSource, options: PgDocumentTreeStoreOptions = {}) {
    this.client = toPgClient(client);
    this.table = options.table ?? 'agent_rag_trees';
    this.unitsTable = options.unitsTable ?? `${this.table}_units`;
    for (const name of [this.table, this.unitsTable]) {
      if (!IDENTIFIER.test(name)) {
        throw new Error(`PgDocumentTreeStore: invalid table name ${JSON.stringify(name)}`);
      }
    }
    this.insertBatchSize = Math.max(1, Math.floor(options.insertBatchSize ?? 200));
  }

  /** The idempotent DDL {@link PgDocumentTreeStore.ensureSchema} runs, in order — for a migration. */
  schemaStatements(): string[] {
    const index = this.table.replace('.', '_');
    return [
      `CREATE TABLE IF NOT EXISTS ${this.table} (
        document_id TEXT PRIMARY KEY,
        title TEXT,
        description TEXT,
        structure TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        unit_count INTEGER NOT NULL,
        source TEXT,
        metadata JSONB,
        tree JSONB NOT NULL,
        built_at TIMESTAMPTZ NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS ${index}_metadata_idx ON ${this.table} USING gin (metadata)`,
      `CREATE TABLE IF NOT EXISTS ${this.unitsTable} (
        document_id TEXT NOT NULL,
        idx INTEGER NOT NULL,
        page INTEGER,
        text TEXT NOT NULL,
        PRIMARY KEY (document_id, idx)
      )`,
    ];
  }

  async ensureSchema(): Promise<void> {
    for (const statement of this.schemaStatements()) {
      await this.client.query(statement);
    }
  }

  /**
   * The SQL conditions a metadata `filter` compiles to (ANDed), appending bindings to `params`.
   * Override to map a filter onto your own columns. Return `['false']` to deny.
   */
  protected whereConditions(
    filter: Record<string, unknown> | undefined,
    params: unknown[],
  ): string[] {
    return buildWhere(filter, params);
  }

  /** Replace the tree and its units in one transaction (when the client has one). */
  async put(tree: DocumentTree, units: TreeUnit[]): Promise<void> {
    const clean = stripNulBytes(tree);
    const { metadata, ...rest } = clean;
    const write = async (client: PgClient) => {
      await client.query(`DELETE FROM ${this.unitsTable} WHERE document_id = $1`, [
        clean.documentId,
      ]);
      for (let start = 0; start < units.length; start += this.insertBatchSize) {
        const batch = units.slice(start, start + this.insertBatchSize);
        const params: unknown[] = [];
        const rows = batch.map((unit) => {
          params.push(clean.documentId, unit.index, unit.page ?? null, stripNulBytes(unit.text));
          const at = params.length;
          return `($${at - 3}, $${at - 2}, $${at - 1}, $${at})`;
        });
        await client.query(
          `INSERT INTO ${this.unitsTable} (document_id, idx, page, text) VALUES ${rows.join(', ')}`,
          params,
        );
      }
      await client.query(
        `INSERT INTO ${this.table}
           (document_id, title, description, structure, fingerprint, unit_count, source, metadata, tree, built_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10)
         ON CONFLICT (document_id) DO UPDATE SET
           title = EXCLUDED.title, description = EXCLUDED.description, structure = EXCLUDED.structure,
           fingerprint = EXCLUDED.fingerprint, unit_count = EXCLUDED.unit_count, source = EXCLUDED.source,
           metadata = EXCLUDED.metadata, tree = EXCLUDED.tree, built_at = EXCLUDED.built_at`,
        [
          clean.documentId,
          clean.title ?? null,
          clean.description ?? null,
          clean.structure,
          clean.fingerprint,
          clean.unitCount,
          clean.source ?? null,
          metadata === undefined ? null : JSON.stringify(metadata),
          JSON.stringify(rest),
          clean.builtAt,
        ],
      );
    };
    const transaction = this.client.transaction?.bind(this.client);
    await (transaction !== undefined ? transaction(write) : write(this.client));
  }

  async get(
    documentId: string,
    filter?: Record<string, unknown>,
  ): Promise<DocumentTree | undefined> {
    return (await this.getMany([documentId], filter))[0];
  }

  async getMany(
    documentIds: readonly string[],
    filter?: Record<string, unknown>,
  ): Promise<DocumentTree[]> {
    if (documentIds.length === 0) {
      return [];
    }
    const params: unknown[] = [[...new Set(documentIds)]];
    const conditions = ['document_id = ANY($1::text[])', ...this.whereConditions(filter, params)];
    const rows = await this.client.query<TreeRow>(
      `SELECT document_id, metadata, tree FROM ${this.table} WHERE ${conditions.join(' AND ')}`,
      params,
    );
    return rows.map((row) => {
      const tree = json<Omit<DocumentTree, 'metadata'>>(row.tree) as DocumentTree;
      const metadata = json<Record<string, unknown>>(row.metadata);
      return { ...tree, ...(metadata !== undefined ? { metadata } : {}) };
    });
  }

  async list(
    options: {
      filter?: Record<string, unknown>;
      documentIds?: readonly string[];
      limit?: number;
    } = {},
  ): Promise<DocumentTreeHeader[]> {
    const params: unknown[] = [];
    const conditions = this.whereConditions(options.filter, params);
    if (options.documentIds !== undefined) {
      params.push([...options.documentIds]);
      conditions.push(`document_id = ANY($${params.length}::text[])`);
    }
    let limit = '';
    if (options.limit !== undefined) {
      params.push(Math.max(0, Math.floor(options.limit)));
      limit = `LIMIT $${params.length}`;
    }
    const rows = await this.client.query<TreeRow>(
      `SELECT document_id, title, description, structure, fingerprint, unit_count, source, metadata, built_at
         FROM ${this.table}
         ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}
         ORDER BY document_id ${limit}`,
      params,
    );
    return rows.map((row) => {
      const metadata = json<Record<string, unknown>>(row.metadata);
      return headerOf({
        documentId: row.document_id,
        version: 1,
        ...(row.title !== null ? { title: row.title } : {}),
        ...(row.description !== null ? { description: row.description } : {}),
        structure: row.structure,
        fingerprint: row.fingerprint,
        unitCount: Number(row.unit_count),
        nodes: [],
        stats: {
          llmCalls: 0,
          inputTokens: 0,
          outputTokens: 0,
          durationMs: 0,
          budgetExhausted: false,
          reusedSummaries: 0,
        },
        ...(metadata !== undefined ? { metadata } : {}),
        ...(row.source !== null ? { source: row.source } : {}),
        builtAt: row.built_at instanceof Date ? row.built_at.toISOString() : String(row.built_at),
      });
    });
  }

  async readUnits(documentId: string, start: number, end: number): Promise<TreeUnit[]> {
    const rows = await this.client.query<{ idx: number; page: number | null; text: string }>(
      `SELECT idx, page, text FROM ${this.unitsTable}
        WHERE document_id = $1 AND idx BETWEEN $2 AND $3 ORDER BY idx`,
      [documentId, Math.max(0, start), end],
    );
    return rows.map((row) => ({
      index: Number(row.idx),
      text: row.text,
      ...(row.page !== null ? { page: Number(row.page) } : {}),
    }));
  }

  async remove(documentId: string): Promise<void> {
    const work = async (client: PgClient) => {
      await client.query(`DELETE FROM ${this.unitsTable} WHERE document_id = $1`, [documentId]);
      await client.query(`DELETE FROM ${this.table} WHERE document_id = $1`, [documentId]);
    };
    const transaction = this.client.transaction?.bind(this.client);
    await (transaction !== undefined ? transaction(work) : work(this.client));
  }
}
