import type { AiToolCtx, EmbeddingProvider, Passage, Retriever } from '@dudousxd/nestjs-agent-core';
import { type ChunkOptions, chunkText } from './chunk.js';
import { EmbeddingRetriever, type EmbeddingRetrieverOptions } from './embedding-retriever.js';
import { type EmbeddingUsage, embedCountingUsage } from './embedding-usage.js';
import { FilteredRetriever } from './filtered-retriever.js';
import { type RetrievalTool, createRetrievalTool } from './retrieval-tool.js';
import { type VectorStore, replaceDocumentChunks } from './vector-store.js';

/** The metadata key separating models that share one store. Reserved: it always wins over yours. */
export const RAG_ENTITY_KEY = 'ragEntity';

/** What a scope value can be. Compared as strings, so `7` and `'7'` are the same scope everywhere. */
export type RagScopeValue = string | number;

/** Maps a scope key to the function reading it from a row. `{}` declares a global corpus. */
export type RagScopeDefinition<Row> = Record<string, (row: Row) => RagScopeValue>;

/** A required scope value was missing or malformed. Thrown before any embedding is paid for. */
export class RagScopeRequiredError extends Error {
  constructor(
    readonly model: string,
    readonly key: string,
  ) {
    super(`${model} needs scope.${key}: its chunks are isolated by it`);
    this.name = 'RagScopeRequiredError';
  }
}

const ANY_OF = Symbol.for('@dudousxd/nestjs-agent-rag/anyOf');

/** See {@link anyOf}. */
export interface RagAnyOf<Value> {
  readonly [ANY_OF]: readonly Value[];
}

/**
 * Search several scope values at once. An empty list matches nothing. It is a wrapper rather than a
 * plain array so that an array arriving from a request can't widen a search by accident.
 */
export function anyOf<Value extends RagScopeValue>(values: readonly Value[]): RagAnyOf<Value> {
  return { [ANY_OF]: values };
}

function isScopeValue(value: unknown): value is RagScopeValue {
  return typeof value === 'number'
    ? Number.isFinite(value)
    : typeof value === 'string' && value !== '';
}

function isAnyOf(value: unknown): value is RagAnyOf<RagScopeValue> {
  return typeof value === 'object' && value !== null && ANY_OF in value;
}

/** The scope a search must carry: every key of the definition, with the type its function returns. */
export type RagScopeOf<Scope> = {
  [Key in keyof Scope]: Scope[Key] extends (row: never) => infer Value
    ? Value | RagAnyOf<Value>
    : never;
};

/** A `scope` is required unless the definition declared none. A `filter` can't name a scope key. */
export type RagSearchOptions<Scope> = {
  topK?: number;
  filter?: Record<string, unknown> & { [Key in keyof Scope]?: never };
} & (keyof Scope extends never ? { scope?: undefined } : { scope: RagScopeOf<Scope> });

export interface RagIndexDefinition<Row, Scope extends RagScopeDefinition<Row>> {
  /** Namespaces document ids (`<name>:<id>`) and the {@link RAG_ENTITY_KEY} metadata. */
  name: string;
  id: (row: Row) => RagScopeValue;
  /** The text to index. Blank removes the row's chunks. */
  text: (row: Row) => string | null | undefined;
  /** Required on purpose: a global corpus has to say `scope: {}`. */
  scope: Scope;
  /** Citation-facing origin of each chunk. */
  source?: (row: Row) => string | null | undefined;
  /** Extra chunk metadata. Can't override the scope. */
  metadata?: (row: Row) => Record<string, unknown>;
  chunk?: ChunkOptions;
  /** Keep only the first N chunks: an upper bound on what one huge document can cost. */
  maxChunks?: number;
  minScore?: EmbeddingRetrieverOptions['minScore'];
}

export interface RagIndexDeps {
  store: VectorStore;
  embedder: EmbeddingProvider;
  /**
   * Replaces the default dense retriever (hybrid, reranked). It must honour `options.filter`, which
   * carries the scope. Embedding spend it does on its own doesn't reach `onUsage`.
   */
  retriever?: Retriever;
  /** Embedding spend, indexing and searching alike. This package can't know who pays for it. */
  onUsage?: (usage: EmbeddingUsage) => void | Promise<void>;
}

export interface RagReconcileOptions<Scope> {
  /** Compare only this part of the corpus. `liveIds` then only has to cover that part. */
  scope?: Partial<{ [Key in keyof Scope]: Scope[Key] extends (row: never) => infer V ? V : never }>;
  /** Report without removing anything. */
  dryRun?: boolean;
}

export interface RagReconcileResult {
  /** Indexed document ids with no live row. Removed, unless `dryRun`. */
  orphans: string[];
  /** Live document ids with no chunks: never indexed, or blank. Nothing is embedded for them here. */
  missing: string[];
}

export interface RagToolOptions<Scope> {
  name: string;
  description?: string;
  topK?: number;
  /** From the tool context, never from the model's input. */
  scope: (ctx: AiToolCtx) => RagScopeOf<Scope>;
}

/**
 * The framework-free core behind `RagRepository`: one model's chunks in a shared store, with a scope
 * that a search can't omit or override. It only composes what this package already has; cost, quota
 * and access control stay in the app.
 *
 * Saving a row doesn't index it, because embedding is a slow, paid call. Call {@link RagIndex.index}
 * from a job, or wherever the text is known to have changed.
 */
export class RagIndex<Row, Scope extends RagScopeDefinition<Row>> {
  private readonly embedder: EmbeddingProvider;

  constructor(
    private readonly definition: RagIndexDefinition<Row, Scope>,
    private readonly deps: RagIndexDeps,
  ) {
    const { onUsage } = deps;
    this.embedder =
      onUsage === undefined
        ? deps.embedder
        : {
            embed: async (texts) => {
              const { vectors, usage } = await embedCountingUsage(deps.embedder, texts);
              if (usage !== undefined) {
                await onUsage(usage);
              }
              return vectors;
            },
          };
  }

  /** The id this row's chunks are stored under: `<name>:<id>`. */
  documentId(id: RagScopeValue): string {
    // An unsaved row would otherwise index under `name:undefined`, shared with every other such row.
    if (!isScopeValue(id)) {
      throw new Error(`${this.definition.name}: a row needs an id to be indexed or removed`);
    }
    return `${this.definition.name}:${String(id)}`;
  }

  /** A `Retriever` locked to this scope, for `HybridRetriever`, `createRetrievalTool` and so on. */
  scoped(scope: RagScopeOf<Scope>): Retriever {
    return new FilteredRetriever(this.baseRetriever(), this.scopeFilter(scope));
  }

  async search(query: string, options: RagSearchOptions<Scope>): Promise<Passage[]> {
    const { scope, filter, topK } = options as {
      scope?: RagScopeOf<Scope>;
      filter?: Record<string, unknown>;
      topK?: number;
    };
    return this.scoped(scope as RagScopeOf<Scope>).retrieve(query, {
      ...(topK !== undefined ? { topK } : {}),
      ...(filter !== undefined ? { filter } : {}),
    });
  }

  /**
   * Replaces the row's chunks and returns how many were written. Embeddings come first: if the
   * provider fails, the previous chunks are still there. The swap is one transaction on Postgres; on a
   * store without `replaceDocument` a crash mid-swap loses the document until the next `index`.
   */
  async index(row: Row): Promise<number> {
    const { definition, deps } = this;
    const documentId = this.documentId(definition.id(row));
    // Refuses a row with no scope value: its chunks could never be found again.
    const scope = this.scopeFilter(
      Object.fromEntries(
        Object.entries(definition.scope).map(([key, read]) => [key, read(row)]),
      ) as RagScopeOf<Scope>,
    );
    const text = definition.text(row)?.trim();
    if (!text) {
      await deps.store.remove(documentId);
      return 0;
    }
    const pieces = chunkText(text, definition.chunk).slice(0, definition.maxChunks);
    const embeddings = await this.embedder.embed(pieces);
    const source = definition.source?.(row) ?? undefined;
    const metadata = { ...definition.metadata?.(row), ...scope };
    await replaceDocumentChunks(
      deps.store,
      documentId,
      pieces.map((piece, index) => ({
        id: `${documentId}#${index}`,
        text: piece,
        embedding: embeddings[index] ?? [],
        ...(source !== undefined ? { source } : {}),
        metadata,
      })),
    );
    return pieces.length;
  }

  /** Takes the id itself once the row is gone. */
  remove(rowOrId: Row | RagScopeValue): Promise<void> {
    const id =
      typeof rowOrId === 'string' || typeof rowOrId === 'number'
        ? rowOrId
        : this.definition.id(rowOrId);
    return this.deps.store.remove(this.documentId(id));
  }

  /**
   * Diffs the index against the ids that exist, and removes what no hook could: `ON DELETE CASCADE`,
   * raw SQL, a crash after a commit. `liveIds` must be complete for the part being compared, because
   * anything left out is removed. Use `dryRun` to look first.
   */
  async reconcile(
    liveIds: Iterable<RagScopeValue> | AsyncIterable<RagScopeValue>,
    options: RagReconcileOptions<Scope> = {},
  ): Promise<RagReconcileResult> {
    const filter: Record<string, unknown> = { [RAG_ENTITY_KEY]: this.definition.name };
    for (const [key, value] of Object.entries(options.scope ?? {})) {
      if (!isScopeValue(value)) {
        throw new RagScopeRequiredError(this.definition.name, key);
      }
      filter[key] = String(value);
    }
    const live = new Set<string>();
    for await (const id of liveIds) {
      live.add(this.documentId(id));
    }
    const indexed = await this.deps.store.listDocumentIds(filter);
    const orphans = indexed.filter((id) => !live.has(id));
    if (options.dryRun !== true) {
      await this.deps.store.removeMany(orphans);
    }
    const known = new Set(indexed);
    return { orphans, missing: [...live].filter((id) => !known.has(id)) };
  }

  /** A `search_*` tool whose scope comes from the context. Pass it to `provideAgentTool`. */
  tool(options: RagToolOptions<Scope>): RetrievalTool {
    return createRetrievalTool(this.baseRetriever(), {
      name: options.name,
      ...(options.description !== undefined ? { description: options.description } : {}),
      ...(options.topK !== undefined ? { topK: options.topK } : {}),
      filter: (ctx) => this.scopeFilter(options.scope(ctx)),
    });
  }

  private baseRetriever(): Retriever {
    const { minScore } = this.definition;
    return (
      this.deps.retriever ??
      new EmbeddingRetriever(
        this.embedder,
        this.deps.store,
        minScore !== undefined ? { minScore } : {},
      )
    );
  }

  /** The filter a scope compiles to. Throws on anything but a usable value, before any paid call. */
  private scopeFilter(scope: RagScopeOf<Scope> | undefined): Record<string, unknown> {
    const given = (scope ?? {}) as Record<string, unknown>;
    const filter: Record<string, unknown> = { [RAG_ENTITY_KEY]: this.definition.name };
    for (const key of Object.keys(this.definition.scope)) {
      const value = given[key];
      if (isAnyOf(value) && value[ANY_OF].every(isScopeValue)) {
        filter[key] = value[ANY_OF].map(String);
      } else if (isScopeValue(value)) {
        filter[key] = String(value);
      } else {
        throw new RagScopeRequiredError(this.definition.name, key);
      }
    }
    return filter;
  }
}

/**
 * The fields a `RedisVectorStore` must declare in `filterableFields` to serve these scopes:
 * RediSearch can only filter on a key declared up front.
 */
export function ragFilterableFields(...scopeKeys: string[]): string[] {
  return [...new Set([RAG_ENTITY_KEY, ...scopeKeys])];
}
