import type { Passage } from '@dudousxd/nestjs-agent-core';
import {
  type IndexedDocument,
  type LexicalVectorStore,
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
