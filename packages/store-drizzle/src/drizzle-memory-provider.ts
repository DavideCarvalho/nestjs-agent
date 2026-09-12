import {
  type ForgetMemoryInput,
  type ListMemoriesInput,
  type MemoryProvider,
  type MemoryRecord,
  type StoreMemoryInput,
  actorScope,
} from '@dudousxd/nestjs-agent-core';
import { and, eq, inArray } from 'drizzle-orm';
import { type AgentDrizzleDb, type AgentMemoryRow, agentMemory } from './schema.js';

/** One row as the library reads it. The origin travels so a person can ask "says who?". */
function toRecord(row: AgentMemoryRow): MemoryRecord {
  return {
    id: row.id,
    key: row.key,
    text: row.text,
    scope: row.scope,
    origin: {
      author: row.originAuthor,
      ...(row.originThreadId !== null ? { threadId: row.originThreadId } : {}),
      ...(row.originRunId !== null ? { runId: row.originRunId } : {}),
      ...(row.originActorRef !== null ? { actorRef: row.originActorRef } : {}),
    },
    updatedAt: row.updatedAt.toISOString(),
    pinned: row.pinned,
  };
}

/**
 * {@link MemoryProvider} backed by Drizzle, over the `agent_memory` table this package's
 * `ensureAgentSchema` creates. The host app owns and supplies the db handle.
 *
 * `search` IS NOT IMPLEMENTED, and that is a decision rather than an omission. It is optional on the
 * SPI, and what it buys is a block filled by relevance once the applicable set outgrows
 * `maxMemories` — which needs an index over the memories themselves, and an index is the half a
 * general-purpose table cannot supply: the shape depends entirely on what a deployment already runs
 * (pgvector, a full-text index, a hybrid service), and picking one here would make this adapter
 * require infrastructure most hosts do not have for a ceiling most of them never reach. Without
 * `search`, `list` reads the applicable scopes whole and the ceiling never bites.
 *
 * The signal that it is worth building is `MemoryDigest.omitted` going non-zero — and
 * `pinnedOmitted` especially, which means a standing policy stopped reaching any prompt. Both are on
 * the `aviary:agent:memory.resolved` diagnostic. A host that gets there implements `search` against
 * its own index and passes it as the provider, or wraps this one.
 */
export class DrizzleMemoryProvider implements MemoryProvider {
  constructor(private readonly db: AgentDrizzleDb) {}

  /**
   * Every memory visible at `scopes` — asked on EVERY turn, so it is one indexed `scope in (…)`
   * against the leading column of the (`scope`, `key`) unique index.
   *
   * The scope filter is in the QUERY. The library drops out-of-scope records it is handed, but that
   * is a backstop: a memory held for another actor or another tenant is never selected here, so it
   * is unreachable rather than outranked.
   */
  async list({ scopes }: ListMemoriesInput): Promise<MemoryRecord[]> {
    if (scopes.length === 0) {
      return [];
    }
    const rows = await this.db
      .select()
      .from(agentMemory)
      .where(inArray(agentMemory.scope, [...scopes]));
    return rows.map(toRecord);
  }

  /**
   * Delete one, and only from the actor's OWN scope.
   *
   * `memoryForgetVerdict` already holds the library's endpoint to that rule; the `where` repeats it
   * because `forget` takes an id and nothing else, so a caller reaching this provider by any other
   * path would otherwise delete a tenant's or the deployment's memory by knowing one id.
   *
   * `false` where nothing matched — which covers "no such id" and "not yours" identically, so the
   * answer cannot be used to find out which memories exist about other people.
   */
  async forget({ id, ctx }: ForgetMemoryInput): Promise<boolean> {
    const deleted = await this.db
      .delete(agentMemory)
      .where(and(eq(agentMemory.id, id), eq(agentMemory.scope, actorScope(ctx.actor))))
      .returning({ id: agentMemory.id });
    return deleted.length > 0;
  }

  /**
   * Upsert on (`scope`, `key`) — one statement, against the unique index, rather than a read
   * followed by a write: two turns concluding the same key at once would otherwise race to a
   * duplicate-key insert and one of them would fail the `remember` tool.
   *
   * The conflict `set` names exactly what a rewrite may change, so `pinned`, `createdAt` and `id`
   * are left alone by construction rather than by an exclusion anyone could forget to extend.
   * Dropping `pinned` would silently unpin a row the next time the agent restated the fact;
   * rewriting `createdAt` would lose when the belief was first formed; reassigning `id` would
   * invalidate the delete handle a person was already shown.
   */
  async write({ key, text, scope, origin, ctx }: StoreMemoryInput): Promise<MemoryRecord> {
    assertAuthorMayWriteScope({ scope, origin, ctx });
    const now = new Date();
    const columns = {
      originAuthor: origin.author,
      originThreadId: origin.threadId ?? null,
      originRunId: origin.runId ?? null,
      originActorRef: origin.actorRef ?? null,
    };
    const [row] = await this.db
      .insert(agentMemory)
      .values({
        id: crypto.randomUUID(),
        scope,
        key,
        text,
        ...columns,
        pinned: false,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [agentMemory.scope, agentMemory.key],
        set: { text, ...columns, updatedAt: now },
      })
      .returning();
    if (row === undefined) {
      throw new Error(
        `DrizzleMemoryProvider: the upsert of "${key}" at "${scope}" returned no row; the driver does not support RETURNING on conflict.`,
      );
    }
    return toRecord(row);
  }

  /**
   * Make one memory always-on, or stop it being one. The operator act the SPI has no method for, on
   * purpose: a pin grants a fact a permanent place in every future prompt, so nothing an agent can
   * reach may set it. Authorize it in your own console — this takes no `ScopeContext` because it is
   * not an actor's act on their own memory.
   *
   * `false` where there is no such id.
   */
  async pin({ id, pinned }: { id: string; pinned: boolean }): Promise<boolean> {
    const updated = await this.db
      .update(agentMemory)
      .set({ pinned, updatedAt: new Date() })
      .where(eq(agentMemory.id, id))
      .returning({ id: agentMemory.id });
    return updated.length > 0;
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
      `DrizzleMemoryProvider: refusing to write an agent-authored memory at "${scope}"; an agent may write only at "${own}"`,
    );
  }
}
