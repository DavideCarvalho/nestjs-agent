import type { Passage } from '@dudousxd/nestjs-agent-core';
import {
  type IndexedDocument,
  type VectorRecord,
  type VectorSearchOptions,
  type VectorStore,
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
            // Array metadata is stored as a multi-valued TAG (comma-separated, RediSearch's default
            // separator) so a document can carry several capability tokens; individual values must
            // therefore not contain commas.
            const tag = Array.isArray(value) ? value.map(String).join(',') : String(value);
            args.push(`meta_${field}`, tag);
          }
        }
      }
      await this.client.sendCommand(args);
    }
  }

  async remove(documentId: string): Promise<void> {
    const keys = new Set<string>([`${this.prefix}${documentId}`]);
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
    if (keys.size > 0) {
      await this.client.sendCommand(['DEL', ...keys]);
    }
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
 * A filter with an empty-array value can never match (nothing is a member of the empty set) — and
 * RediSearch has no valid empty-tag syntax, so callers short-circuit to an empty result instead of
 * emitting a broken query. This is the deny primitive (e.g. an actor with no capability tokens).
 */
function filterMatchesNothing(filter?: Record<string, unknown>): boolean {
  if (filter === undefined) {
    return false;
  }
  return Object.values(filter).some((value) => Array.isArray(value) && value.length === 0);
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
