import type { AiToolCtx, Passage, ToolHandler, ToolSpec } from '@dudousxd/nestjs-agent-core';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { documentIdOf } from '../vector-store.js';
import type { TreeBudget } from './llm.js';
import type { NavigatedNode, NavigationStep, TreeNavigationRetriever } from './navigate.js';

export interface NavigateDocumentToolOptions {
  /** Tool name the model sees. Default `navigate_document`. */
  name?: string;
  description?: string;
  /**
   * The access filter for this call, from the tool context — e.g. `(ctx) => ({ tenant: ctx.actor.tenantRef })`.
   * Applied to the tree read, with the vector stores' semantics. Omit only for single-tenant corpora.
   */
  filter?: (ctx: AiToolCtx) => Record<string, unknown> | undefined;
  /** Per-call navigation budget (overrides the navigator's). */
  budget?: TreeBudget;
}

export interface NavigateDocumentInput {
  documentId: string;
  question: string;
}

export interface NavigateDocumentOutput {
  documentId: string;
  /** `false` when the document has no tree (short documents don't get one) or the caller may not read it. */
  found: boolean;
  passages: Passage[];
  /** The sections chosen and the path to each. */
  nodes: NavigatedNode[];
  /** The walk, step by step, with the model's reasoning. */
  steps: NavigationStep[];
  stoppedBy?: string;
  note?: string;
}

/** A functional tool (`{ spec, handler }`) — pass it to nestjs `provideAgentTool`. */
export interface NavigateDocumentTool {
  spec: ToolSpec;
  handler: ToolHandler;
}

function isInput(value: unknown): value is NavigateDocumentInput {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).documentId === 'string' &&
    typeof (value as Record<string, unknown>).question === 'string'
  );
}

const inputSchema: StandardSchemaV1<NavigateDocumentInput> = {
  '~standard': {
    version: 1,
    vendor: 'nestjs-agent-rag',
    validate(value: unknown) {
      return isInput(value)
        ? { value: { documentId: value.documentId, question: value.question } }
        : {
            issues: [
              { message: 'navigate_document expects { documentId: string, question: string }' },
            ],
          };
    },
  },
};

/**
 * The agentic half of two-stage retrieval: `navigate_document(documentId, question)`, a `read`-kind
 * tool the model calls **after** `search_knowledge` put a long document among its hits — it walks
 * that document's table of contents to the sections that answer and returns their text, with the
 * path and reasoning (the citation surface: section titles and page ranges).
 *
 * `documentId` may also be a chunk id from a search result (`doc#12`); the chunk suffix is dropped.
 * A document with no tree answers `found: false` with a note, so the model falls back to the
 * passages it already has instead of retrying.
 *
 * ```ts
 * providers: [
 *   provideAgentTool(createRetrievalTool(hybrid)),
 *   provideAgentTool(createNavigateDocumentTool(navigator, { filter: (ctx) => ({ tenant: ctx.actor.tenantRef }) })),
 * ]
 * ```
 */
export function createNavigateDocumentTool(
  navigator: TreeNavigationRetriever,
  options: NavigateDocumentToolOptions = {},
): NavigateDocumentTool {
  return {
    spec: {
      name: options.name ?? 'navigate_document',
      kind: 'read',
      description:
        options.description ??
        'Read inside one long document (regulation, contract, filing, manual) by navigating its table of contents to the sections that answer a question. Use it after a search returned a long document: pass that document id and the question. Returns the matching sections with titles and page ranges for citation.',
      inputSchema,
    },
    handler: {
      async execute(input: unknown, ctx: AiToolCtx): Promise<NavigateDocumentOutput> {
        if (!isInput(input)) {
          throw new Error('navigate_document expects { documentId: string, question: string }');
        }
        const filter = options.filter?.(ctx);
        const navigateOptions = {
          ...(filter !== undefined ? { filter } : {}),
          ...(options.budget !== undefined ? { budget: options.budget } : {}),
        };
        let documentId = input.documentId.trim();
        let result = await navigator.navigate(input.question, [documentId], navigateOptions);
        let navigation = result.documents[0];
        if (navigation?.stoppedBy === 'not-found') {
          const bare = documentIdOf(documentId.replace(/#node:\d+$/, ''));
          if (bare !== documentId) {
            documentId = bare;
            result = await navigator.navigate(input.question, [documentId], navigateOptions);
            navigation = result.documents[0];
          }
        }
        if (navigation === undefined || navigation.stoppedBy === 'not-found') {
          return {
            documentId,
            found: false,
            passages: [],
            nodes: [],
            steps: [],
            note: 'This document has no navigable table of contents (it is short, not indexed, or not accessible). Use the search passages instead.',
          };
        }
        return {
          documentId,
          found: true,
          passages: result.passages,
          nodes: navigation.nodes,
          steps: navigation.steps,
          ...(navigation.stoppedBy !== undefined ? { stoppedBy: navigation.stoppedBy } : {}),
          ...(navigation.nodes.length === 0
            ? { note: 'No section of this document looked relevant to the question.' }
            : {}),
        };
      },
    },
  };
}
