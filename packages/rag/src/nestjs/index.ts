import type { Passage, Retriever } from '@dudousxd/nestjs-agent-core';
import {
  type ChunkOptions,
  RagIndex,
  type RagIndexDeps,
  type RagReconcileOptions,
  type RagReconcileResult,
  type RagScopeDefinition,
  type RagScopeOf,
  type RagScopeValue,
  type RagSearchOptions,
  type RagToolOptions,
  type RetrievalTool,
} from '@dudousxd/nestjs-agent-rag';
import { type DynamicModule, Inject, Module, type Type } from '@nestjs/common';

/** Token of the `store` and `embedder` every {@link RagRepository} uses. */
export const RAG_INDEX_DEPS = Symbol.for('@dudousxd/nestjs-agent-rag/index-deps');

/**
 * RAG for one model, as a provider of your own. The entity (or Drizzle table) doesn't change:
 *
 * ```ts
 * @Injectable()
 * export class DocumentsRag extends RagRepository<ProjectDocument> {
 *   protected readonly name = 'project_documents';
 *   readonly scope = { projectId: (d: ProjectDocument) => d.project.id };
 *   protected id(d: ProjectDocument) { return d.id; }
 *   protected text(d: ProjectDocument) { return d.textContent; }
 * }
 *
 * await documentsRag.index(doc);
 * await documentsRag.search('question', { scope: { projectId } });
 * ```
 *
 * `scope` is abstract, so leaving it out doesn't compile, and its shape types `search`. A corpus
 * shared by everyone has to say `scope = {}`.
 */
export abstract class RagRepository<Row> {
  @Inject(RAG_INDEX_DEPS) private readonly ragIndexDeps!: RagIndexDeps;

  /** Namespaces document ids and the metadata that separates models sharing a store. */
  protected abstract readonly name: string;
  abstract readonly scope: RagScopeDefinition<Row>;
  protected readonly chunk?: ChunkOptions;
  protected readonly maxChunks?: number;
  protected readonly minScore?: number;

  /** The value `remove` needs once the row is gone. */
  abstract id(row: Row): RagScopeValue;
  protected abstract text(row: Row): string | null | undefined;
  protected source(_row: Row): string | null | undefined {
    return undefined;
  }
  protected metadata(_row: Row): Record<string, unknown> {
    return {};
  }

  private core?: RagIndex<Row, RagScopeDefinition<Row>>;

  // Built on first use: `name` and `scope` are subclass fields, and the deps are injected after both.
  private get ragIndex(): RagIndex<Row, RagScopeDefinition<Row>> {
    this.core ??= new RagIndex(
      {
        name: this.name,
        scope: this.scope,
        id: (row) => this.id(row),
        text: (row) => this.text(row),
        source: (row) => this.source(row),
        metadata: (row) => this.metadata(row),
        ...(this.chunk !== undefined ? { chunk: this.chunk } : {}),
        ...(this.maxChunks !== undefined ? { maxChunks: this.maxChunks } : {}),
        ...(this.minScore !== undefined ? { minScore: this.minScore } : {}),
      },
      this.ragIndexDeps,
    );
    return this.core;
  }

  search(query: string, options: RagSearchOptions<this['scope']>): Promise<Passage[]> {
    return this.ragIndex.search(query, options as never);
  }

  scoped(scope: RagScopeOf<this['scope']>): Retriever {
    return this.ragIndex.scoped(scope as never);
  }

  index(row: Row): Promise<number> {
    return this.ragIndex.index(row);
  }

  remove(rowOrId: Row | RagScopeValue): Promise<void> {
    return this.ragIndex.remove(rowOrId);
  }

  reconcile(
    liveIds: Iterable<RagScopeValue> | AsyncIterable<RagScopeValue>,
    options?: RagReconcileOptions<this['scope']>,
  ): Promise<RagReconcileResult> {
    return this.ragIndex.reconcile(liveIds, options as never);
  }

  tool(options: RagToolOptions<this['scope']>): RetrievalTool {
    return this.ragIndex.tool(options as never);
  }
}

export interface RagModuleAsyncOptions {
  imports?: DynamicModule['imports'];
  inject?: unknown[];
  useFactory: (...args: never[]) => RagIndexDeps | Promise<RagIndexDeps>;
}

@Module({})
class RagFeatureModule {}

/** `forRoot` holds the store and embedder, globally; `forFeature` registers repositories. */
@Module({})
export class RagModule {
  static forRoot(deps: RagIndexDeps): DynamicModule {
    return {
      module: RagModule,
      global: true,
      providers: [{ provide: RAG_INDEX_DEPS, useValue: deps }],
      exports: [RAG_INDEX_DEPS],
    };
  }

  static forRootAsync(options: RagModuleAsyncOptions): DynamicModule {
    return {
      module: RagModule,
      global: true,
      ...(options.imports !== undefined ? { imports: options.imports } : {}),
      providers: [
        {
          provide: RAG_INDEX_DEPS,
          inject: (options.inject ?? []) as never[],
          useFactory: options.useFactory as (...args: unknown[]) => RagIndexDeps,
        },
      ],
      exports: [RAG_INDEX_DEPS],
    };
  }

  static forFeature(repositories: Type<unknown>[]): DynamicModule {
    return { module: RagFeatureModule, providers: repositories, exports: repositories };
  }
}
