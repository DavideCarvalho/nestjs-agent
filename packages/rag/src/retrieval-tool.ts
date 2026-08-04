import type { Passage, Retriever, ToolHandler, ToolSpec } from '@dudousxd/nestjs-agent-core';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { type InstrumentRetrieverOptions, instrumentRetriever } from './retrieval-telemetry.js';

export interface RetrievalToolOptions {
  /** Tool name the model sees. Default `search_knowledge`. */
  name?: string;
  description?: string;
  /** Passages per search. Default lets the retriever decide (typically 5). */
  topK?: number;
  /**
   * Retrieval telemetry (`aviary:rag:retrieval` — duration, chunk count, score distribution, store
   * and collection). **On by default**, because this tool is the once-per-retrieval seam in agentic
   * mode: instrumenting here is what makes the RAG panels work for a host that only ever calls
   * `createRetrievalTool`, with no wiring at all. It costs nothing when nobody subscribes (see
   * {@link instrumentRetriever}), and cannot double-count when the host has already wrapped the
   * retriever itself.
   *
   * Pass `false` to opt a single tool out — a host that reports retrieval its own way, or one whose
   * corpus is small enough that the events are noise.
   */
  telemetry?: boolean | InstrumentRetrieverOptions;
}

/** A functional tool (`{ spec, handler }`) — pass it to nestjs `provideAgentTool`. */
export interface RetrievalTool {
  spec: ToolSpec;
  handler: ToolHandler;
}

function isQueryInput(value: unknown): value is { query: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'query' in value &&
    typeof (value as Record<'query', unknown>).query === 'string'
  );
}

/** A hand-rolled Standard Schema for `{ query: string }` — keeps this package validation-lib-free. */
const querySchema: StandardSchemaV1<{ query: string }> = {
  '~standard': {
    version: 1,
    vendor: 'nestjs-agent-rag',
    validate(value: unknown) {
      return isQueryInput(value)
        ? { value: { query: value.query } }
        : { issues: [{ message: 'retrieval tool expects { query: string }' }] };
    },
  },
};

/**
 * Builds the agentic-retrieval tool: a `read`-kind `search_knowledge(query)` the model calls when it
 * decides it needs context. Its output `{ passages }` persists as the tool call's result, so sources
 * flow to the frontend and telescope through the normal tool-call machinery (the citation surface).
 *
 * The retrieval ITSELF is also instrumented (`aviary:rag:retrieval`) unless `telemetry: false` — the
 * tool-call row says a retrieval happened, the retrieval event says how long it took, how much came
 * back and how good it was. See {@link instrumentRetriever}.
 *
 * ```ts
 * providers: [provideAgentTool(createRetrievalTool(retriever))]
 * ```
 */
export function createRetrievalTool(
  retriever: Retriever,
  options: RetrievalToolOptions = {},
): RetrievalTool {
  const topK = options.topK;
  const { telemetry = true } = options;
  const instrumented =
    telemetry === false
      ? retriever
      : instrumentRetriever(retriever, telemetry === true ? {} : telemetry);
  return {
    spec: {
      name: options.name ?? 'search_knowledge',
      kind: 'read',
      description:
        options.description ??
        'Search the knowledge base for passages relevant to a query. Returns passages with their source for citation.',
      inputSchema: querySchema,
    },
    handler: {
      async execute(input: unknown): Promise<{ passages: Passage[] }> {
        if (!isQueryInput(input)) {
          throw new Error('retrieval tool expects { query: string }');
        }
        const passages = await instrumented.retrieve(
          input.query,
          topK !== undefined ? { topK } : {},
        );
        return { passages };
      },
    },
  };
}
