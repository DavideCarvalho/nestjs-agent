import {
  type ForgetMemoryInput,
  type ListMemoriesInput,
  type MemoryProvider,
  type MemoryRecord,
  type SearchMemoriesInput,
  type StoreMemoryInput,
  actorScope,
} from '@dudousxd/nestjs-agent-core';

/** Options for {@link InMemoryMemoryProvider}. */
export interface InMemoryMemoryProviderOptions {
  /**
   * Serve `search` as well as `list`, ranking by how many of the query's words a record's key and
   * fact contain.
   *
   * Absent, the provider has NO `search` property at all — which is the switch the loop reads, so
   * the default instance exercises the same read-whole path a deployment with no index runs. Turn it
   * on to exercise the other one: a ranked block, `MemoryDigest.recalled`, and the three clauses of
   * {@link MemoryProvider.search} — the third of which (every record sharing a returned key travels,
   * plus every pinned one) is the one an adapter is most likely to get wrong.
   *
   * Word overlap is not a relevance model. It is deterministic, which is what a spec needs, and it
   * ranks nothing a real deployment would ship.
   */
  recall?: boolean;
}

/** A memory as the map holds it. `pinned` is always present so a read-back never has to guess. */
type StoredMemory = MemoryRecord & { pinned: boolean };

/**
 * A fully in-memory {@link MemoryProvider} for specs, local dev and the offline demo.
 *
 * It is the reference for the two rules a memory adapter has to hold, and both are enforced here in
 * the LOOKUP rather than after it — the library drops out-of-scope records it is handed, but that is
 * a backstop and an adapter that leans on it has made privacy a property of the caller:
 *
 * - `list`/`search` return only records at the scopes they were given, so a memory held for another
 *   actor or another tenant is unreachable rather than outranked.
 * - `forget` deletes only from the actor's OWN scope, so an id alone cannot reach a tenant's or the
 *   deployment's memory.
 */
export class InMemoryMemoryProvider implements MemoryProvider {
  private readonly records = new Map<string, StoredMemory>();
  private sequence = 0;

  /**
   * Present only when constructed with `{ recall: true }`. A property rather than a method because
   * its ABSENCE is meaningful: `offerMemories` reads `provider.search !== undefined` to decide
   * whether a turn is filled by relevance or read whole, and a method on the prototype is never
   * absent.
   */
  readonly search?: (input: SearchMemoriesInput) => MemoryRecord[];

  constructor(options: InMemoryMemoryProviderOptions = {}) {
    if (options.recall === true) {
      this.search = (input) => this.rank(input);
    }
  }

  list({ scopes }: ListMemoriesInput): MemoryRecord[] {
    return this.visible(scopes);
  }

  forget({ id, ctx }: ForgetMemoryInput): boolean {
    const record = this.records.get(id);
    // "No such id" and "not yours" answer identically, so the result cannot be used to find out
    // which memories exist about other people.
    if (record === undefined || record.scope !== actorScope(ctx.actor)) {
      return false;
    }
    return this.records.delete(id);
  }

  /**
   * Upsert on (`scope`, `key`).
   *
   * `pinned` is carried ACROSS the upsert and never written: it is an operator's decision about how
   * much of every future prompt a fact gets, and an upsert that reset it would silently unpin a row
   * the next time the agent restated the same key.
   */
  write({ key, text, scope, origin, ctx }: StoreMemoryInput): MemoryRecord {
    assertAuthorMayWriteScope({ scope, origin, ctx });
    const existing = this.at(scope, key);
    const record: StoredMemory = {
      id: existing?.id ?? `mem-${++this.sequence}`,
      key,
      text,
      scope,
      origin,
      updatedAt: new Date().toISOString(),
      pinned: existing?.pinned ?? false,
    };
    this.records.set(record.id, copy(record));
    return copy(record);
  }

  /**
   * Make one memory always-on, or stop it being one. The operator act the SPI has no method for, on
   * purpose: a pin grants a fact a permanent place in every future prompt, so nothing an agent can
   * reach may set it. A host authorizes this in its own console.
   *
   * `false` where there is no such id.
   */
  pin({ id, pinned }: { id: string; pinned: boolean }): boolean {
    const record = this.records.get(id);
    if (record === undefined) {
      return false;
    }
    this.records.set(id, { ...record, pinned });
    return true;
  }

  /** Every record held, at any scope — for a spec asserting on what a write actually stored. */
  all(): MemoryRecord[] {
    return [...this.records.values()].map(copy);
  }

  private visible(scopes: readonly string[]): StoredMemory[] {
    const held = [...this.records.values()];
    return held.filter((record) => scopes.includes(record.scope)).map(copy);
  }

  private at(scope: string, key: string): StoredMemory | undefined {
    return [...this.records.values()].find(
      (record) => record.scope === scope && record.key === key,
    );
  }

  /**
   * The three clauses of {@link MemoryProvider.search}, in order: gate to `scopes`, rank the KEYS
   * and take the best `limit`, then return every record sharing a returned key plus every pinned
   * one. A key scoring nothing is left out rather than padded in — a search that returned the whole
   * scope would make `recalled` a lie about how the block was filled.
   *
   * The result is ordered MOST RELEVANT FIRST, by the rank of each record's key, because that order
   * IS the answer under `ranked` — `resolveMemoryDigest` selects by a record's position rather than
   * by scope, so a provider that returned the right set in the wrong order would hand the ceiling a
   * relevance judgement it never made. Records sharing a key stay together, and a pinned record
   * whose key ranked nothing sorts last: the digest lifts pinned entries ahead of the ceiling
   * regardless, so spending a relevance slot on one would drop a record that was actually asked for.
   */
  private rank({ scopes, query, limit }: SearchMemoriesInput): MemoryRecord[] {
    const visible = this.visible(scopes);
    const terms = words(query);
    const best = new Map<string, number>();
    for (const record of visible) {
      const score = overlap(terms, words(`${record.key} ${record.text}`));
      best.set(record.key, Math.max(best.get(record.key) ?? 0, score));
    }
    const ranked = new Map<string, number>(
      [...best]
        .filter(([, score]) => score > 0)
        .sort(([keyA, scoreA], [keyB, scoreB]) => scoreB - scoreA || compare(keyA, keyB))
        .slice(0, Math.max(0, limit))
        .map(([key], index): [string, number] => [key, index]),
    );
    const unranked = ranked.size;
    return visible
      .filter((record) => record.pinned || ranked.has(record.key))
      .sort((a, b) => (ranked.get(a.key) ?? unranked) - (ranked.get(b.key) ?? unranked));
  }
}

/**
 * An agent may not choose the scope it writes at — the storage half of the rule `memoryWriteVerdict`
 * states. `StoreMemoryInput` carries a `scope` because a host's own console legitimately publishes at
 * a wider one, and `writeMemory` only ever passes the actor's own; so what an adapter can check from
 * what it is handed is exactly rule three: nothing but a human writes above its own scope.
 *
 * Whether that human may write THERE — membership, elevation — needs facts an adapter is not given
 * (`ScopeContext` carries no resolved scope list and no elevation), and is answered by
 * `memoryWriteVerdict`, which `writeMemory` and a host's console both call. `origin.author` is the
 * axis, and no model-facing path can set it: the `remember` tool has no such parameter and
 * `writeMemory` hardcodes `'agent'`.
 *
 * Restated in each memory adapter with the same wording, so the refusal a host sees does not depend
 * on which store it picked.
 */
function assertAuthorMayWriteScope({
  scope,
  origin,
  ctx,
}: Pick<StoreMemoryInput, 'scope' | 'origin' | 'ctx'>): void {
  const own = actorScope(ctx.actor);
  if (origin.author !== 'human' && scope !== own) {
    throw new Error(
      `InMemoryMemoryProvider: refusing to write an agent-authored memory at "${scope}"; an agent may write only at "${own}"`,
    );
  }
}

/**
 * A detached copy of one record, `origin` included.
 *
 * Every value crossing the store's boundary — in through `write`, out through `write`'s return,
 * `list`, `search` and `all` — goes through this, so nothing a caller holds is ever the object the
 * map holds. A SQL adapter gets this for free by mapping rows; a map-backed one has to do it, and
 * without it a consumer mutating what it read would silently rewrite the store. That divergence is
 * the worst kind for this package, whose whole job is to be the shape other adapters are held to.
 */
function copy(record: StoredMemory): StoredMemory {
  return { ...record, origin: { ...record.origin } };
}

/** Lowercased word tokens, so `Fiscal-Year?` and `fiscal year` match. */
function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 0),
  );
}

function overlap(query: Set<string>, candidate: Set<string>): number {
  let matched = 0;
  for (const term of query) {
    if (candidate.has(term)) {
      matched += 1;
    }
  }
  return matched;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
