/** Exact-match metadata filter (every key in `filter` must equal the record's). Shared by the
 * in-memory {@link import('./memory-vector-store.js').MemoryVectorStore} and
 * {@link import('./keyword-retriever.js').KeywordRetriever}. */
export function matchesFilter(
  metadata: Record<string, unknown> | undefined,
  filter: Record<string, unknown>,
): boolean {
  if (metadata === undefined) {
    return Object.keys(filter).length === 0;
  }
  return Object.entries(filter).every(([key, value]) => metadata[key] === value);
}
