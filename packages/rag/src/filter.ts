/** Metadata filter, shared by the in-memory {@link import('./memory-vector-store.js').MemoryVectorStore}
 * and {@link import('./keyword-retriever.js').KeywordRetriever}. Every key must match:
 *
 * - a **scalar** filter value keeps exact-match — the record's value must equal it;
 * - an **array** filter value means **match-any** (OR / set membership) — the record matches when its
 *   value for that key is one of them, or (for a multi-valued record) shares at least one element.
 *   An empty array matches nothing (no value is a member of the empty set) — the deny primitive.
 *
 * Array-valued filters are how a caller expresses capability-style access control over a shared store
 * (e.g. `{ audience: ['public', 'role:ADMIN', 'base:…'] }`) without the store knowing what a token means.
 */
export function matchesFilter(
  metadata: Record<string, unknown> | undefined,
  filter: Record<string, unknown>,
): boolean {
  const entries = Object.entries(filter);
  if (metadata === undefined) {
    return entries.length === 0;
  }
  return entries.every(([key, expected]) => {
    if (Array.isArray(expected)) {
      const actual = metadata[key];
      return Array.isArray(actual)
        ? actual.some((value) => expected.includes(value))
        : expected.includes(actual);
    }
    return metadata[key] === expected;
  });
}
