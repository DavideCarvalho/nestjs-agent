import type { Passage, Retriever, ToolHandler, ToolSpec } from '@dudousxd/nestjs-agent-core';
import type { StandardSchemaV1 } from '@standard-schema/spec';

export interface RetrievalToolOptions {
  /** Tool name the model sees. Default `search_knowledge`. */
  name?: string;
  description?: string;
  /** Passages per search. Default lets the retriever decide (typically 5). */
  topK?: number;
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
 * ```ts
 * providers: [provideAgentTool(createRetrievalTool(retriever))]
 * ```
 */
export function createRetrievalTool(
  retriever: Retriever,
  options: RetrievalToolOptions = {},
): RetrievalTool {
  const topK = options.topK;
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
        const passages = await retriever.retrieve(input.query, topK !== undefined ? { topK } : {});
        return { passages };
      },
    },
  };
}
