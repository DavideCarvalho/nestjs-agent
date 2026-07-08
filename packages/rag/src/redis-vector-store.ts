import type { Passage } from '@dudousxd/nestjs-agent-core';
import type { VectorRecord, VectorSearchOptions, VectorStore } from './vector-store.js';

/**
 * The minimal Redis surface {@link RedisVectorStore} needs: send a raw command and get the reply.
 * Both `node-redis` (`client.sendCommand(args)`) and `ioredis` (wrap `redis.call`) satisfy it — so
 * this package pulls in NO Redis driver (bring your own, like the other adapters). Requires the
 * RediSearch module (Redis Stack / Redis 8+).
 */
export interface RedisSearchClient {
  sendCommand(args: (string | Buffer)[]): Promise<unknown>;
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
}

/**
 * A RediSearch-backed {@link VectorStore} — HNSW + cosine over Redis, the ecosystem-native option
 * for anyone already running Redis (see `-transport-redis`). Chunks are hashes under `prefix`, the
 * embedding a FLOAT32 vector field; `search` is a KNN query. Call {@link RedisVectorStore.ensureSchema}
 * once at boot to create the index.
 */
export class RedisVectorStore implements VectorStore {
  private readonly index: string;
  private readonly prefix: string;
  private readonly dimensions: number;
  private readonly filterableFields: string[];

  constructor(
    private readonly client: RedisSearchClient,
    options: RedisVectorStoreOptions = {},
  ) {
    this.index = options.index ?? 'agent_rag_idx';
    this.prefix = options.prefix ?? 'agent_rag:';
    this.dimensions = options.dimensions ?? 1536;
    this.filterableFields = options.filterableFields ?? [];
  }

  /** Idempotent: create the HNSW/cosine index if `FT.INFO` says it doesn't exist yet. */
  async ensureSchema(): Promise<void> {
    try {
      await this.client.sendCommand(['FT.INFO', this.index]);
      return;
    } catch {
      // index missing → create it below
    }
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
            args.push(`meta_${field}`, String(value));
          }
        }
      }
      await this.client.sendCommand(args);
    }
  }

  async search(embedding: number[], options: VectorSearchOptions): Promise<Passage[]> {
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
}

/** RediSearch expects a little-endian FLOAT32 buffer for the query/stored vector. */
function encodeVector(embedding: number[]): Buffer {
  return Buffer.from(new Float32Array(embedding).buffer);
}

/** `*` for no filter, else an AND of TAG clauses like `(@meta_owner:{u1} @meta_tenant:{t1})`. */
function buildFilter(filter?: Record<string, unknown>): string {
  if (filter === undefined || Object.keys(filter).length === 0) {
    return '*';
  }
  const clauses = Object.entries(filter).map(
    ([key, value]) => `@meta_${key}:{${escapeTag(String(value))}}`,
  );
  return `(${clauses.join(' ')})`;
}

/** Escape RediSearch TAG punctuation so an id/tenant value matches literally. */
function escapeTag(value: string): string {
  return value.replace(/[^a-zA-Z0-9_]/g, (char) => `\\${char}`);
}

function toStr(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  return Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
}

/**
 * Parse an `FT.SEARCH` reply into passages, tolerating both wire shapes: the RESP2 array
 * `[total, key, [f, v, …], …]` (ioredis / node-redis RESP2) and the RESP3 object
 * `{ results: [{ id, extra_attributes: { … } }] }` (node-redis's default). Distance → similarity
 * via `1 - distance` (COSINE), and the `prefix` is stripped back off the key to recover the chunk id.
 */
function parseSearchReply(reply: unknown, prefix: string): Passage[] {
  if (Array.isArray(reply)) {
    const passages: Passage[] = [];
    for (let index = 1; index + 1 < reply.length; index += 2) {
      const rawFields = reply[index + 1];
      if (Array.isArray(rawFields)) {
        const attrs: Record<string, string> = {};
        for (let field = 0; field + 1 < rawFields.length; field += 2) {
          attrs[toStr(rawFields[field])] = toStr(rawFields[field + 1]);
        }
        passages.push(toPassage(toStr(reply[index]), attrs, prefix));
      }
    }
    return passages;
  }
  if (typeof reply === 'object' && reply !== null && 'results' in reply) {
    const results = (reply as { results: unknown }).results;
    if (Array.isArray(results)) {
      return results.map((result) => toPassage(readId(result), readAttributes(result), prefix));
    }
  }
  return [];
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

function toPassage(rawId: string, attrs: Record<string, string>, prefix: string): Passage {
  const distance = Number(attrs.vector_score ?? '1');
  const source = attrs.source;
  return {
    id: rawId.startsWith(prefix) ? rawId.slice(prefix.length) : rawId,
    text: attrs.text ?? '',
    score: 1 - distance,
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
