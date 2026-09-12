import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { type SQL, and, asc, count, desc, eq, gt, lt, or } from 'drizzle-orm';
import {
  type AgentDrizzleDb,
  type RagIngestionLogRow,
  type RagIngestionStatus,
  ragIngestionLog,
} from './schema.js';

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
 * with its log row already gone, and how a reconcile re-embeds documents it already has.
 * `documentId` is the table's primary key, so appending it makes the order total and the pages
 * disjoint.
 *
 * Exported because it is a contract, not an implementation detail: a caller that polls page 1 for a
 * document it just rewrote depends on `updated_at desc`, and a caller that pages depends on the
 * tiebreaker. Spread it into a query of your own (`.orderBy(...RAG_INGESTION_LOG_PAGE_ORDER)`) to
 * read this table the way {@link DrizzleRagIngestionLog} does — and to keep `iterate`'s keyset
 * arithmetic, which is derived from exactly this order, in view.
 */
export const RAG_INGESTION_LOG_PAGE_ORDER: SQL[] = [
  desc(ragIngestionLog.updatedAt),
  asc(ragIngestionLog.documentId),
];

/** Default rows per page for {@link DrizzleRagIngestionLog.list} / `listPage`. */
const DEFAULT_PAGE_SIZE = 200;

/** Default rows per round-trip for {@link DrizzleRagIngestionLog.iterate}. */
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
const CURSOR_COLUMNS = {
  documentId: ragIngestionLog.documentId,
  updatedAt: ragIngestionLog.updatedAt,
};

/** The coordinates half of a log query: which rows, with nothing said about paging. */
export interface RagIngestionLogWhere {
  collection?: string;
  status?: RagIngestionStatus;
}

export interface RagIngestionLogQuery extends RagIngestionLogWhere {
  limit?: number;
  offset?: number;
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
 * `aviary:rag:*` diagnostics channels `@dudousxd/nestjs-agent-rag-media` publishes — the Drizzle
 * counterpart of `MikroOrmRagIngestionLog`, with the same columns, ordering and write semantics, so
 * a console built on one adapter reads the other.
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
export class DrizzleRagIngestionLog implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DrizzleRagIngestionLog.name);
  private teardowns: (() => void)[] = [];
  private readonly inFlight = new Set<Promise<void>>();

  constructor(private readonly db: AgentDrizzleDb) {}

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
  async list(query: RagIngestionLogQuery = {}): Promise<RagIngestionLogRow[]> {
    const rows = this.db
      .select()
      .from(ragIngestionLog)
      .where(this.where(query))
      .orderBy(...RAG_INGESTION_LOG_PAGE_ORDER)
      .limit(query.limit ?? DEFAULT_PAGE_SIZE);
    return query.offset === undefined ? rows : rows.offset(query.offset);
  }

  /**
   * The same page plus the unpaginated total, so a caller can tell "these are all of them" from
   * "these are the first N". A list that silently truncates reads as complete when it isn't.
   *
   * Offset paging is only sound over a table nobody is deleting from underneath you: a row removed
   * behind the cursor shifts everything after it back by one, so the next page starts one row late
   * and that row is never seen. Use {@link iterate} for any sweep that deletes.
   */
  async listPage(
    query: RagIngestionLogQuery = {},
  ): Promise<{ rows: RagIngestionLogRow[]; total: number }> {
    const [totalRow] = await this.db
      .select({ value: count() })
      .from(ragIngestionLog)
      .where(this.where(query));
    return { rows: await this.list(query), total: totalRow?.value ?? 0 };
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
   * There is no `limit`/`offset` here on purpose: `where` says *which* rows, `options` says how the
   * sweep is run. A sweep that stops early stops by `break`ing out of the `for await`.
   */
  iterate(
    where: RagIngestionLogWhere = {},
    options: RagIngestionLogIterateOptions = {},
  ): AsyncGenerator<RagIngestionLogRow, void, undefined> {
    return this.sweep(where, batches(options.batchSize), options.after, (filter, limit) =>
      this.db
        .select()
        .from(ragIngestionLog)
        .where(filter)
        .orderBy(...RAG_INGESTION_LOG_PAGE_ORDER)
        .limit(limit),
    );
  }

  /**
   * Just the document ids of the matching rows, in {@link RAG_INGESTION_LOG_PAGE_ORDER}.
   *
   * Returns **all** of them — no 200-row cap, unlike `list` — by sweeping on {@link iterate}'s
   * keyset internally, so it is correct against concurrent deletes for the same reason `iterate`
   * is. What the cap protects against is hydrating an unbounded number of wide rows (`error` is a
   * TEXT column); this selects two columns — the id, plus the `updatedAt` the cursor needs — and
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
    const rows = this.sweep(where, batches(options.batchSize), undefined, (filter, limit) =>
      this.db
        .select(CURSOR_COLUMNS)
        .from(ragIngestionLog)
        .where(filter)
        .orderBy(...RAG_INGESTION_LOG_PAGE_ORDER)
        .limit(limit),
    );
    for await (const row of rows) {
      ids.push(row.documentId);
    }
    return ids;
  }

  /** The latest recorded outcome for one document, or null if it was never attempted. */
  async get(documentId: string): Promise<RagIngestionLogRow | null> {
    const [row] = await this.db
      .select()
      .from(ragIngestionLog)
      .where(eq(ragIngestionLog.documentId, documentId));
    return row ?? null;
  }

  /** Forget one document's record. Returns whether a row was actually removed. */
  async remove(documentId: string): Promise<boolean> {
    const removed = await this.db
      .delete(ragIngestionLog)
      .where(eq(ragIngestionLog.documentId, documentId))
      .returning({ documentId: ragIngestionLog.documentId });
    return removed.length > 0;
  }

  /** Forget every record for a collection — for when the collection itself is deleted. */
  async removeByCollection(collection: string): Promise<number> {
    const removed = await this.db
      .delete(ragIngestionLog)
      .where(eq(ragIngestionLog.collection, collection))
      .returning({ documentId: ragIngestionLog.documentId });
    return removed.length;
  }

  /**
   * The keyset sweep both {@link iterate} and {@link listDocumentIds} are made of. `page` decides
   * how wide a row is — whole rows for `iterate`, two columns for `listDocumentIds` — and the
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
    page: (filter: SQL | undefined, limit: number) => Promise<R[]>,
  ): AsyncGenerator<R, void, undefined> {
    let cursor = after;
    for (;;) {
      const rows = await page(this.keyset(where, cursor), batchSize);
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

  private where(query: RagIngestionLogWhere): SQL | undefined {
    return and(
      query.collection !== undefined ? eq(ragIngestionLog.collection, query.collection) : undefined,
      query.status !== undefined ? eq(ragIngestionLog.status, query.status) : undefined,
    );
  }

  /**
   * The coordinates filter AND'd with "strictly after `cursor` in
   * {@link RAG_INGESTION_LOG_PAGE_ORDER}".
   *
   * The order is `updatedAt desc, documentId asc`, so "after" means an older timestamp, or the same
   * timestamp and a larger id. Both halves are needed: the `<` alone would re-yield every row tied
   * with the cursor, and dropping the tie branch would skip them instead.
   */
  private keyset(
    where: RagIngestionLogWhere,
    cursor: RagIngestionLogCursor | undefined,
  ): SQL | undefined {
    const base = this.where(where);
    if (cursor === undefined) {
      return base;
    }
    return and(
      base,
      or(
        lt(ragIngestionLog.updatedAt, cursor.updatedAt),
        and(
          eq(ragIngestionLog.updatedAt, cursor.updatedAt),
          gt(ragIngestionLog.documentId, cursor.documentId),
        ),
      ),
    );
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
      const now = new Date();
      // Only the coordinates the payload actually carries go into the conflict `set`, so an update
      // leaves the others untouched — a sparser later event (e.g. `removed`, which knows the owner
      // but not the collection) can't blank out what an earlier `ingested` recorded.
      const collection = str(payload.collection);
      const ownerType = str(payload.ownerType);
      const ownerId = str(payload.ownerId);
      const source = str(payload.source);
      const mimeType = str(payload.mimeType);
      const size = num(payload.size);
      const outcome = {
        status,
        // The three outcome-specific columns are exclusive: null out the ones this status doesn't
        // own on every write, so a successful retry clears the previous attempt's error rather than
        // leaving it next to a working document. Always present → always in the conflict `set`.
        chunks: status === 'ingested' ? num(payload.chunks) : null,
        reason: status === 'skipped' ? str(payload.reason) : null,
        error: status === 'failed' ? str(payload.error) : null,
        updatedAt: now,
        ...(collection !== null ? { collection } : {}),
        ...(ownerType !== null ? { ownerType } : {}),
        ...(ownerId !== null ? { ownerId } : {}),
        ...(source !== null ? { source } : {}),
        ...(mimeType !== null ? { mimeType } : {}),
        ...(size !== null ? { size } : {}),
      };
      // Atomic insert-or-update keyed by the document id (the primary key). Two concurrent events
      // for the same NEW document can't race to a duplicate-key insert the way find-then-insert
      // would. `createdAt` is set on insert but absent from the conflict `set`, so an update never
      // overwrites it.
      await this.db
        .insert(ragIngestionLog)
        .values({ documentId, createdAt: now, ...outcome })
        .onConflictDoUpdate({ target: ragIngestionLog.documentId, set: outcome });
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
