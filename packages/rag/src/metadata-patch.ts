/**
 * A partial update to a document's metadata, as taken by
 * {@link import('./vector-store.js').VectorStore.updateMetadata}. Deliberately *partial*: the useful
 * shape is "this one dimension was reclassified", not "here is the whole metadata object again" —
 * a caller that had the whole object would have to reconstruct fields it does not own (the ingestion
 * fingerprint, the source, the mime type) just to change one string, and would silently drop them
 * the day the library adds another.
 *
 * The semantics are RFC 7386 (JSON Merge Patch), with one deliberate narrowing:
 *
 * - **Merge, not replace.** Keys present in the patch are written; keys absent from it keep their
 *   stored value.
 * - **`null` removes the key.** That is the RFC's sentinel and it is the *only* way to remove one.
 *   The consequence — a literal `null` cannot be stored as a value — is intended: metadata is a
 *   filter surface, and "the key is absent" and "the key is null" would filter identically anyway.
 * - **`undefined` is ignored** — the key is left exactly as stored, as if the patch had not mentioned
 *   it. `undefined` does not survive `JSON.stringify`, and a patch routinely crosses a JSON boundary
 *   (an HTTP body, a durable-workflow step payload) on its way here; honouring it would make
 *   `{ audience: undefined }` mean *delete* on one side of that boundary and *no-op* on the other.
 *   It is also what `{ ...doc, audience: doc.audience }` produces by accident, and an accidental
 *   deletion of an access-control dimension is the worst outcome this API can have. Removing a key
 *   is therefore always spelled `null`.
 * - **Shallow.** A value replaces wholesale; it is not merged into the stored value. This is the
 *   narrowing versus RFC 7386, which recurses into nested objects. It matters most for **arrays**,
 *   where wholesale replacement is certainly what a caller means: `{ bases: ['A', 'C'] }` sets the
 *   document's bases to exactly A and C — it does not append to, or union with, what was there. An
 *   array-valued key is a *set-valued dimension* (the multi-valued TAG a store filters on), and the
 *   only sane way to shrink such a set is to state the new one.
 */
export type MetadataPatch = Record<string, unknown>;

/**
 * Split a patch into the assignments it makes and the keys it removes — the shape a store that
 * updates metadata declaratively (SQL, a hash write + field delete) needs, since setting and
 * unsetting are different operations there. `undefined` values appear in neither.
 */
export function splitMetadataPatch(patch: MetadataPatch): {
  set: Record<string, unknown>;
  remove: string[];
} {
  const set: Record<string, unknown> = {};
  const remove: string[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      remove.push(key);
    } else if (value !== undefined) {
      set[key] = value;
    }
  }
  return { set, remove };
}

/** Does this patch write anything at all? An empty (or all-`undefined`) patch is a no-op. */
export function isEmptyMetadataPatch(patch: MetadataPatch): boolean {
  const { set, remove } = splitMetadataPatch(patch);
  return Object.keys(set).length === 0 && remove.length === 0;
}

/**
 * Apply a {@link MetadataPatch} to a document's stored metadata, returning a NEW object — the
 * reference implementation of the semantics documented on `MetadataPatch`, so every adapter that
 * merges in JS agrees with every other one. Never mutates its input: `MemoryVectorStore` hands out
 * the very object a caller upserted, and quietly rewriting it under them would be a surprise no
 * other store reproduces.
 */
export function applyMetadataPatch(
  metadata: Record<string, unknown> | undefined,
  patch: MetadataPatch,
): Record<string, unknown> {
  const { set, remove } = splitMetadataPatch(patch);
  const next: Record<string, unknown> = { ...metadata, ...set };
  for (const key of remove) {
    delete next[key];
  }
  return next;
}
