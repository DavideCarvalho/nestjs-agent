import type { Passage, RetrieveOptions, Retriever } from '@dudousxd/nestjs-agent-core';

/**
 * Wraps a `Retriever` so every `retrieve` call ANDs a fixed metadata `filter` on top of whatever the
 * caller passes — the owner/tenant-scoping primitive. `new FilteredRetriever(base, { ownerId })` only
 * ever returns that owner's passages, so a shared vector store serves per-user / per-tenant RAG
 * without the agent (or a crafted query) reaching across the boundary.
 *
 * The fixed filter takes precedence on key conflicts: a caller can narrow further but cannot widen
 * past the scope. Composes over ANY retriever (vector, hybrid, reranked) and is itself a `Retriever`.
 */
export class FilteredRetriever implements Retriever {
  constructor(
    private readonly base: Retriever,
    private readonly filter: Record<string, unknown>,
  ) {}

  async retrieve(query: string, options: RetrieveOptions = {}): Promise<Passage[]> {
    return this.base.retrieve(query, {
      ...options,
      filter: { ...options.filter, ...this.filter },
    });
  }
}
