import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import {
  type EntityData,
  EntityManager,
  type FilterQuery,
  type QueryOrderMap,
} from '@mikro-orm/core';
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { RagIngestionLog, type RagIngestionStatus } from './entities/rag-ingestion-log.entity';

/**
 * The `aviary:rag:*` payloads this recorder reads, re-declared here so it couples to the *wire
 * contract* of the diagnostics channel rather than importing `@dudousxd/nestjs-agent-rag-media` —
 * the same convention that package uses for the media channels it consumes. Keep in sync with
 * `rag-media`'s `diagnostics.ts`.
 */
interface RagOutcomePayload {
  mediaId?: unknown;
  ownerType?: unknown;
  ownerId?: unknown;
  collection?: unknown;
  source?: unknown;
  mimeType?: unknown;
  size?: unknown;
  chunks?: unknown;
  reason?: unknown;
  error?: unknown;
}

const CHANNELS: { name: string; status: RagIngestionStatus }[] = [
  { name: 'aviary:rag:media.ingested', status: 'ingested' },
  { name: 'aviary:rag:media.skipped', status: 'skipped' },
  { name: 'aviary:rag:media.failed', status: 'failed' },
  { name: 'aviary:rag:media.removed', status: 'removed' },
];

/** Narrow an unknown payload field to a string, treating everything else as absent. */
function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * The paging order: newest first, tiebroken on the primary key.
 *
 * `updatedAt` alone is not a total order — a bulk upload stamps every document of the batch with the
 * same second — and a database is free to return tied rows in a different sequence for each
 * LIMIT/OFFSET query. A tie straddling a page boundary then hands a caller sweeping the table a row
 * in *neither* page (or the same row twice), which is how an orphan-sweep leaves an S3 object behind
 * with its log row already gone, and how a reconcile re-embeds documents it already has. `documentId`
 * is the entity's primary key, so appending it makes the order total and the pages disjoint.
 *
 * Exported because it is a contract, not an implementation detail: a caller that polls page 1 for a
 * document it just rewrote depends on `updatedAt desc`, and a caller that pages depends on the
 * tiebreaker. Pass it explicitly to {@link MikroOrmRagIngestionLog.listPage} to say so in code —
 * and to keep `iterate`'s keyset arithmetic, which is derived from exactly this order, in view.
 */
export const RAG_INGESTION_LOG_PAGE_ORDER = { updatedAt: 'desc', documentId: 'asc' } as const;

/** Default rows per round-trip for {@link MikroOrmRagIngestionLog.iterate}. */
const DEFAULT_BATCH_SIZE = 200;

/** Rows per round-trip, defaulted and clamped: a batch of 0 or NaN would never terminate. */
function batches(batchSize: number | undefined): number {
  const requested = Math.trunc(batchSize ?? DEFAULT_BATCH_SIZE);
  return Number.isFinite(requested) && requested >= 1 ? requested : DEFAULT_BATCH_SIZE;
}

/**
 * The only two columns a keyset sweep needs to keep going. `listDocumentIds` selects exactly these:
 * the id it returns, plus the `updatedAt` half of the cursor.
 */
const CURSOR_FIELDS = ['documentId', 'updatedAt'] as const;

/** The coordinates half of a log query: which rows, with nothing said about paging. */
export interface RagIngestionLogWhere {
  collection?: string;
  status?: RagIngestionStatus;
}

export interface RagIngestionLogQuery extends RagIngestionLogWhere {
  limit?: number;
  offset?: number;
}

export interface RagIngestionLogPageQuery extends RagIngestionLogQuery {
  /**
   * Overrides {@link RAG_INGESTION_LOG_PAGE_ORDER}. Only override it with an order that is *total*
   * (i.e. ends in `documentId`) — anything less and consecutive pages can overlap or leave a gap on
   * tied rows, which is the whole reason the default has a tiebreaker.
   */
  orderBy?: QueryOrderMap<RagIngestionLog> | QueryOrderMap<RagIngestionLog>[];
}

/**
 * Where a sweep left off: the ordering column plus the primary key, i.e. one point in
 * {@link RAG_INGESTION_LOG_PAGE_ORDER}. Not an opaque token — it is two column values, so a caller
 * may persist it across processes and resume from it.
 */
export interface RagIngestionLogCursor {
  updatedAt: Date;
  documentId: string;
}

export interface RagIngestionLogIterateOptions {
  /**
   * Rows fetched per round-trip. Defaults to 200; anything under 1 or non-finite falls back to
   * that default rather than being honoured — a batch of 0 would fetch nothing and never advance.
   */
  batchSize?: number;
  /** Resume strictly after this point in the order, e.g. a cursor persisted by an earlier sweep. */
  after?: RagIngestionLogCursor;
}

/**
 * Records the outcome of every RAG ingestion into `rag_ingestion_log`, by subscribing to the
 * `aviary:rag:*` diagnostics channels `@dudousxd/nestjs-agent-rag-media` publishes.
 *
 * It answers the question a vector store structurally cannot: *which documents failed to index, and
 * why*. A skipped or failed document produces no chunks, so it is invisible to
 * `VectorStore.listDocuments()` — the index only knows about successes. Pair the two for a complete
 * picture: the store is the truth about what is retrievable, this table is the truth about what was
 * attempted.
 *
 * Writes are best-effort and never throw: this runs detached from any request, on a diagnostics
 * channel, so a failed write must not take down the ingestion that triggered it. A lost row costs
 * observability, not data — the vector store remains the system of record.
 */
@Injectable()
export class MikroOrmRagIngestionLog implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MikroOrmRagIngestionLog.name);
  private teardowns: (() => void)[] = [];
  private readonly inFlight = new Set<Promise<void>>();

  constructor(private readonly em: EntityManager) {}

  onModuleInit(): void {
    for (const channel of CHANNELS) {
      const listener = (message: unknown): void => {
        const payload = (message as { payload?: RagOutcomePayload })?.payload;
        if (payload !== undefined) {
          this.track(this.record(channel.status, payload));
        }
      };
      subscribe(channel.name, listener);
      this.teardowns.push(() => unsubscribe(channel.name, listener));
    }
  }

  async onModuleDestroy(): Promise<void> {
    for (const teardown of this.teardowns) {
      teardown();
    }
    this.teardowns = [];
    await this.settle();
  }

  /** Await every in-flight write — for graceful shutdown and deterministic tests. */
  async settle(): Promise<void> {
    await Promise.allSettled([...this.inFlight]);
  }

  /** The latest recorded outcome per document, newest first. */
  async list(query: RagIngestionLogQuery = {}): Promise<RagIngestionLog[]> {
    return this.em.fork().find(RagIngestionLog, this.where(query), {
      orderBy: RAG_INGESTION_LOG_PAGE_ORDER,
      limit: query.limit ?? 200,
      ...(query.offset !== undefined ? { offset: query.offset } : {}),
    });
  }

  /**
   * The same page plus the unpaginated total, so a caller can tell "these are all of them" from
   * "these are the first N". A list that silently truncates reads as complete when it isn't.
   *
   * Ordered by {@link RAG_INGESTION_LOG_PAGE_ORDER} unless `query.orderBy` says otherwise.
   *
   * Offset paging is only sound over a table nobody is deleting from underneath you: a row removed
   * behind the cursor shifts everything after it back by one, so the next page starts one row late
   * and that row is never seen. Use {@link iterate} for any sweep that deletes.
   */
  async listPage(
    query: RagIngestionLogPageQuery = {},
  ): Promise<{ rows: RagIngestionLog[]; total: number }> {
    const em = this.em.fork();
    const [rows, total] = await em.findAndCount(RagIngestionLog, this.where(query), {
      orderBy: query.orderBy ?? RAG_INGESTION_LOG_PAGE_ORDER,
      limit: query.limit ?? 200,
      ...(query.offset !== undefined ? { offset: query.offset } : {}),
    });
    return { rows, total };
  }

  /**
   * Every matching row, newest first, streamed in batches — the sweep-safe way to walk this table.
   *
   * Paging is *keyset*, not offset: each batch asks for the rows that sort strictly after the last
   * row yielded, using `(updatedAt, documentId)` — one point in
   * {@link RAG_INGESTION_LOG_PAGE_ORDER}, which is total because it ends in the primary key. A
   * cursor made of column values does not move when rows leave the table, which is what makes this
   * delete-safe *by construction* rather than by the caller carefully advancing an offset by only
   * the rows it kept.
   *
   * **The guarantee, stated once:** a row is yielded exactly when — at the moment the batch that
   * would contain it is fetched — the row exists, matches `where`, and sorts strictly after the
   * last row already yielded. Everything below is a consequence of that one sentence.
   *
   * What you can rely on:
   * - **Deleting rows while iterating is safe.** Delete any row you like — the one just yielded, the
   *   whole batch, rows you have not reached yet — and every row that is still there when the sweep
   *   reaches its position is visited exactly once. Nothing is skipped and nothing is repeated,
   *   because deleting a row moves no *other* row's `(updatedAt, documentId)`. (Rows you delete
   *   *ahead* of the cursor are simply never visited, which is the point of deleting them.)
   * - **Ties are safe.** A bulk upload stamps a whole batch with the same `updatedAt`; the
   *   `documentId` tiebreaker keeps consecutive batches disjoint even when every row ties.
   * - **Each row is yielded at most once**, for as long as `updatedAt` only ever moves forward —
   *   which is what `record()` does, since it always stamps `now`.
   *
   * What this is **not**: a snapshot, or a repeatable read. The sweep observes the table as it is
   * when each batch is fetched, so:
   * - A row **inserted** mid-sweep by `record()` is stamped `now`. The order is newest-first, so it
   *   sorts ahead of a cursor the sweep has already moved past, and is not visited. A sweep
   *   therefore never sees documents ingested after it started — the behaviour an orphan sweep
   *   wants, since a document that arrived while you were sweeping is not an orphan. (A *direct*
   *   insert with a backdated `updatedAt` lands ahead of the cursor and **is** visited; nothing in
   *   this class writes one.)
   * - A row **re-ingested** mid-sweep has its `updatedAt` bumped to `now`, moving it ahead of the
   *   cursor for the same reason. If the sweep had already passed it, it is not visited twice; if it
   *   had not, it is **missed for this pass**. That is the honest limit: against a concurrent
   *   writer `iterate` guarantees "at most once", not "at least once". Sweeps that must not miss a
   *   concurrently-rewritten row should be idempotent and run again.
   * - Only a row whose `updatedAt` moves *backwards* — which needs a direct write — can be yielded
   *   twice.
   * - `collection` / `status` are re-evaluated per batch, so a row that stops matching mid-sweep
   *   stops being visited.
   *
   * Each batch runs on a **fresh forked EntityManager**. `list`/`listPage` fork per call, which is
   * enough for one bounded page; a sweep is unbounded and long-lived, and holding one identity map
   * across it would retain every row it ever saw. Forking per batch keeps the working set to one
   * batch. The consequence for callers: yielded entities are not managed by any live context —
   * treat them as data, not as something to mutate and flush.
   *
   * There is no `limit`/`offset` here on purpose: `where` says *which* rows, `options` says how the
   * sweep is run. A sweep that stops early stops by `break`ing out of the `for await`.
   */
  iterate(
    where: RagIngestionLogWhere = {},
    options: RagIngestionLogIterateOptions = {},
  ): AsyncGenerator<RagIngestionLog, void, undefined> {
    return this.sweep(where, batches(options.batchSize), options.after, (em, filter, limit) =>
      em.find(RagIngestionLog, filter, { orderBy: RAG_INGESTION_LOG_PAGE_ORDER, limit }),
    );
  }

  /**
   * Just the document ids of the matching rows, in {@link RAG_INGESTION_LOG_PAGE_ORDER}.
   *
   * Returns **all** of them — no 200-row cap, unlike `list` — by sweeping on {@link iterate}'s
   * keyset internally, so it is correct against concurrent deletes for the same reason `iterate`
   * is. What the cap protects against is hydrating an unbounded number of wide entities (`error` is
   * a TEXT column); this selects two columns — the id, plus the `updatedAt` the cursor needs — and
   * keeps only the ids, so the peak footprint is one batch of two-column rows plus a list of
   * strings whose size *is* the answer the caller asked for.
   *
   * For callers that need the id set of a collection and nothing else: an orphan sweep unioning the
   * log against the vector store's own document list.
   */
  async listDocumentIds(
    where: RagIngestionLogWhere = {},
    options: { batchSize?: number } = {},
  ): Promise<string[]> {
    const ids: string[] = [];
    const rows = this.sweep(where, batches(options.batchSize), undefined, (em, filter, limit) =>
      em.find(RagIngestionLog, filter, {
        orderBy: RAG_INGESTION_LOG_PAGE_ORDER,
        limit,
        fields: CURSOR_FIELDS,
      }),
    );
    for await (const row of rows) {
      ids.push(row.documentId);
    }
    return ids;
  }

  /** The latest recorded outcome for one document, or null if it was never attempted. */
  async get(documentId: string): Promise<RagIngestionLog | null> {
    return this.em.fork().findOne(RagIngestionLog, { documentId });
  }

  /** Forget one document's record. Returns whether a row was actually removed. */
  async remove(documentId: string): Promise<boolean> {
    const deleted = await this.em.fork().nativeDelete(RagIngestionLog, { documentId });
    return deleted > 0;
  }

  /** Forget every record for a collection — for when the collection itself is deleted. */
  async removeByCollection(collection: string): Promise<number> {
    return this.em.fork().nativeDelete(RagIngestionLog, { collection });
  }

  /**
   * The keyset sweep both {@link iterate} and {@link listDocumentIds} are made of. `page` decides
   * how wide a row is — whole entities for `iterate`, two columns for `listDocumentIds` — and the
   * `R extends RagIngestionLogCursor` bound says the only thing the sweep needs back: a row it can
   * read the next cursor off.
   *
   * The cursor advances **per yielded row**, not per batch, so a consumer that `break`s mid-batch
   * leaves it on the last row it actually saw. It is two column values read off that row, so a row
   * leaving the table cannot move it — the whole reason this is delete-safe by construction.
   */
  private async *sweep<R extends RagIngestionLogCursor>(
    where: RagIngestionLogWhere,
    batchSize: number,
    after: RagIngestionLogCursor | undefined,
    page: (em: EntityManager, filter: FilterQuery<RagIngestionLog>, limit: number) => Promise<R[]>,
  ): AsyncGenerator<R, void, undefined> {
    let cursor = after;
    for (;;) {
      // A fresh fork per batch: see iterate()'s note on the identity map.
      const rows = await page(this.em.fork(), this.keyset(where, cursor), batchSize);
      if (rows.length === 0) {
        return;
      }
      for (const row of rows) {
        yield row;
        cursor = { updatedAt: row.updatedAt, documentId: row.documentId };
      }
      // Deliberately NOT `if (rows.length < batchSize) return`: a short batch means "nothing after
      // the cursor *right now*", not "nothing ever". One extra empty query per sweep is what makes
      // termination depend on the table rather than on a batch happening to come back full.
    }
  }

  private where(query: RagIngestionLogWhere): FilterQuery<RagIngestionLog> {
    return {
      ...(query.collection !== undefined ? { collection: query.collection } : {}),
      ...(query.status !== undefined ? { status: query.status } : {}),
    };
  }

  /**
   * The coordinates filter AND'd with "strictly after `cursor` in
   * {@link RAG_INGESTION_LOG_PAGE_ORDER}".
   *
   * The order is `updatedAt desc, documentId asc`, so "after" means an older timestamp, or the same
   * timestamp and a larger id. Both halves are needed: the `$lt` alone would re-yield every row
   * tied with the cursor, and dropping the tie branch would skip them instead.
   */
  private keyset(
    where: RagIngestionLogWhere,
    cursor: RagIngestionLogCursor | undefined,
  ): FilterQuery<RagIngestionLog> {
    const base = this.where(where);
    if (cursor === undefined) {
      return base;
    }
    return {
      ...base,
      $or: [
        { updatedAt: { $lt: cursor.updatedAt } },
        { updatedAt: cursor.updatedAt, documentId: { $gt: cursor.documentId } },
      ],
    };
  }

  /**
   * Upsert one outcome. Keyed by document id so the row always reflects the *current* state — a
   * retry that succeeds overwrites the failure it replaces, rather than leaving a stale error next
   * to a working document.
   */
  private async record(status: RagIngestionStatus, payload: RagOutcomePayload): Promise<void> {
    const documentId = str(payload.mediaId);
    if (documentId === null) {
      return;
    }
    try {
      // forked EM: this runs outside any request, so it must not touch the shared context.
      const em = this.em.fork();
      const now = new Date();
      // Only include coordinates the payload actually carries. An omitted field is left out of the
      // conflict-merge set, so `em.upsert` leaves it untouched on update — a sparser later event
      // (e.g. `removed`, which knows the owner but not the collection) can't blank out what an
      // earlier `ingested` recorded.
      const collection = str(payload.collection);
      const ownerType = str(payload.ownerType);
      const ownerId = str(payload.ownerId);
      const source = str(payload.source);
      const mimeType = str(payload.mimeType);
      const size = num(payload.size);
      const data: EntityData<RagIngestionLog> = {
        documentId,
        status,
        // The three outcome-specific columns are exclusive: null out the ones this status doesn't
        // own on every write, so a successful retry clears the previous attempt's error rather than
        // leaving it next to a working document. Always present → always in the merge set.
        chunks: status === 'ingested' ? num(payload.chunks) : null,
        reason: status === 'skipped' ? str(payload.reason) : null,
        error: status === 'failed' ? str(payload.error) : null,
        createdAt: now,
        updatedAt: now,
        ...(collection !== null ? { collection } : {}),
        ...(ownerType !== null ? { ownerType } : {}),
        ...(ownerId !== null ? { ownerId } : {}),
        ...(source !== null ? { source } : {}),
        ...(mimeType !== null ? { mimeType } : {}),
        ...(size !== null ? { size } : {}),
      };
      // Atomic insert-or-update keyed by the document id (the PK). Two concurrent events for the same
      // NEW document can't race to a duplicate-key insert the way find-then-insert did. `createdAt`
      // is set on insert but excluded from the merge, so an update never overwrites it.
      await em.upsert(RagIngestionLog, data, { onConflictExcludeFields: ['createdAt'] });
    } catch (error) {
      this.logger.warn(
        `Could not record RAG ingestion outcome for ${documentId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private track(promise: Promise<void>): void {
    const tracked = promise.finally(() => {
      this.inFlight.delete(tracked);
    });
    this.inFlight.add(tracked);
  }
}
