import {
  AgentStreamError,
  type SinkWriter,
  type StreamError,
  type TokenStreamSink,
} from './spi/token-stream-sink.js';
import { encodeStreamEvent } from './stream-events.js';

/** One stored row of a run's stream. `frame` is `null` on the terminal row. */
export interface StreamFrameRow {
  seq: number;
  /** One NDJSON line (`{...}\n`) as the writer wrote it; `null` marks the end of the run. */
  frame: string | null;
  /** On the terminal row of a FAILED run: the `StreamError` as JSON. `null` otherwise. */
  error: string | null;
}

/**
 * The table a {@link SqlTokenStreamSink} keeps its rows in — the only part of it that speaks SQL, so
 * a store package implements this and inherits the rest (coalescing, ordering, polling, TTL).
 * `@dudousxd/nestjs-agent-store-drizzle` and `-store-mikro-orm` ship one each, over
 * `agent_stream_frame` (`run_id`, `seq`, `frame`, `error`, `created_at`; primary key
 * `(run_id, seq)`).
 */
export interface StreamFrameTable {
  /**
   * Insert the run's NEXT row: `seq = MAX(seq) + 1` for the run, taken in the SAME statement as the
   * insert, so the `(run_id, seq)` primary key settles two writers that ask at once. Throws on that
   * collision ({@link isUniqueViolation} says which errors are one) — the sink retries.
   */
  append(
    runId: string,
    row: { frame: string | null; error: string | null; createdAt: number },
  ): Promise<void>;
  /** The run's rows with `seq > after`, ascending, at most `limit`. */
  read(runId: string, after: number, limit: number): Promise<StreamFrameRow[]>;
  /** Does the table hold any row for the run? */
  has(runId: string): Promise<boolean>;
  /** Delete every row of these runs. */
  remove(runIds: readonly string[]): Promise<void>;
  /** Runs whose LAST row was written before `cutoff` (epoch-ms). */
  lapsedRuns(cutoff: number): Promise<string[]>;
  /**
   * Is this error a lost race for a `(run_id, seq)` — a duplicate key, or the database rolling this
   * writer back as a deadlock victim (InnoDB's way of settling two concurrent `INSERT … SELECT`) —
   * and nothing else (a missing table, a dead connection)?
   */
  isUniqueViolation(error: unknown): boolean;
}

export interface SqlTokenStreamSinkOptions {
  /**
   * Gap (ms) between two reads of a run a subscriber is following — the most a frame waits in the
   * table before a browser sees it. Default 250.
   */
  pollIntervalMs?: number;
  /**
   * Gap (ms) between two reads once the run has written nothing for five seconds (parked on a
   * person, a slow tool), so an open SSE connection on a quiet run costs one query a second. The
   * first frame to arrive puts the subscriber back on `pollIntervalMs`. Default 1000; never below
   * `pollIntervalMs`.
   */
  idlePollIntervalMs?: number;
  /**
   * Window (ms) consecutive `text` frames are gathered over and written as ONE row — a model
   * streams token by token, and a row per token is more writes than a database should take for a
   * chat answer. Any other frame, `end()`, `fail()` and `flush()` write what is gathered first, so
   * order is kept. Default 50. `0` writes every frame as its own row.
   */
  flushMs?: number;
  /**
   * TTL (seconds) of a run's rows, counted from its LAST write — a long run stays, a run that
   * crashed without ending still lapses. {@link SqlTokenStreamSink.purgeExpired} deletes them.
   * Default 3600 (1h). `0` keeps rows until `close()`.
   */
  ttlSeconds?: number;
  /**
   * Purge lapsed runs as a side effect of ending a run, at most once a minute, so the table stays
   * bounded in an app that never schedules {@link SqlTokenStreamSink.purgeExpired}. Default `true`.
   */
  autoPurge?: boolean;
}

const DEFAULT_TTL_SECONDS = 3600;
const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_IDLE_POLL_INTERVAL_MS = 1000;
const IDLE_AFTER_MS = 5000;
const DEFAULT_FLUSH_MS = 50;
const READ_PAGE = 500;
const PURGE_CHUNK = 200;
const AUTO_PURGE_EVERY_MS = 60_000;
const APPEND_ATTEMPTS = 8;

/** One run's write side in this process: the text being gathered, and the writes already queued. */
interface RunWrites {
  text: string | null;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** Settles when every write queued so far has been attempted. Never rejects. */
  tail: Promise<void>;
  pending: number;
  /** A gathered write that failed on its timer, with nobody awaiting it — raised by the next call. */
  failure: { error: unknown } | undefined;
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The text of a chunk that is exactly one `{"kind":"text","text":…}` line, else `null`. */
function textOf(line: string): string | null {
  if (!line.startsWith('{"kind":"text"')) return null;
  try {
    const parsed: unknown = JSON.parse(line);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      Object.keys(parsed).length === 2 &&
      (parsed as { kind?: unknown }).kind === 'text' &&
      typeof (parsed as { text?: unknown }).text === 'string'
    ) {
      return (parsed as { text: string }).text;
    }
  } catch {
    /* not one event: stored as written */
  }
  return null;
}

/**
 * A multi-replica {@link TokenStreamSink} over the app's SQL database — for a deployment with
 * several replicas and NO Redis. The replica running the turn appends each frame as a row; any
 * replica serves the run's SSE by reading the rows past its cursor, in order, until the terminal
 * row. A late subscriber replays from the first row, as with the in-process and Redis sinks, and a
 * run that `fail()`ed throws its {@link AgentStreamError} after the replay.
 *
 * Two things differ from the Redis sink, both the price of having no broker:
 *
 *  - **Delivery is polled** — a frame waits up to `pollIntervalMs` before a browser sees it.
 *  - **Text is coalesced on the way in.** Consecutive `text` frames written within `flushMs` are
 *    stored as ONE `text` frame. The stored rows ARE the run's stream: every subscriber, on every
 *    replica, reads the same rows in the same order, so the SSE ids `chat/:runId/stream` numbers
 *    them with — and an `?after=` cursor — stay exact across replicas.
 *
 * Sequence numbers are per run, start at 1 and have no gaps (see {@link StreamFrameTable.append}).
 * Text a writer is still gathering lives in the process for at most `flushMs`; a process that dies
 * in that window loses it from the LIVE stream (the persisted message is unaffected).
 *
 * Framework- and dialect-free: the SQL is the {@link StreamFrameTable}'s. Use
 * `DrizzleTokenStreamSink` / `MikroOrmTokenStreamSink` from the store packages.
 */
export class SqlTokenStreamSink implements TokenStreamSink {
  private readonly pollIntervalMs: number;
  private readonly idlePollIntervalMs: number;
  private readonly flushMs: number;
  private readonly ttlSeconds: number;
  private readonly autoPurge: boolean;
  private readonly writes = new Map<string, RunWrites>();
  private lastAutoPurge = 0;

  constructor(
    private readonly table: StreamFrameTable,
    options: SqlTokenStreamSinkOptions = {},
  ) {
    this.pollIntervalMs = Math.max(1, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    this.idlePollIntervalMs = Math.max(
      this.pollIntervalMs,
      options.idlePollIntervalMs ?? DEFAULT_IDLE_POLL_INTERVAL_MS,
    );
    this.flushMs = Math.max(0, options.flushMs ?? DEFAULT_FLUSH_MS);
    this.ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    this.autoPurge = options.autoPurge ?? true;
  }

  private runWrites(runId: string): RunWrites {
    let state = this.writes.get(runId);
    if (state === undefined) {
      state = {
        text: null,
        timer: undefined,
        tail: Promise.resolve(),
        pending: 0,
        failure: undefined,
      };
      this.writes.set(runId, state);
    }
    return state;
  }

  /** Forget a run's write state once nothing is gathered, queued or left to report. */
  private release(runId: string, state: RunWrites): void {
    if (
      state.pending === 0 &&
      state.text === null &&
      state.failure === undefined &&
      this.writes.get(runId) === state
    ) {
      this.writes.delete(runId);
    }
  }

  /** Queue `work` behind every write already queued for the run, so rows land in call order. */
  private enqueue(runId: string, state: RunWrites, work: () => Promise<void>): Promise<void> {
    state.pending += 1;
    const next = state.tail.then(work);
    state.tail = next
      .then(
        () => undefined,
        () => undefined,
      )
      .then(() => {
        state.pending -= 1;
        this.release(runId, state);
      });
    return next;
  }

  /** Queue the gathered text (if any) as one `text` row. */
  private flushText(runId: string, state: RunWrites): Promise<void> {
    if (state.timer !== undefined) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
    if (state.text === null) return Promise.resolve();
    const line = decoder.decode(encodeStreamEvent({ kind: 'text', text: state.text }));
    state.text = null;
    return this.enqueue(runId, state, () => this.append(runId, line, null));
  }

  /** Raise, once, a gathered write that failed with nobody awaiting it. */
  private raiseFailure(state: RunWrites): void {
    const failure = state.failure;
    if (failure !== undefined) {
      state.failure = undefined;
      throw failure.error;
    }
  }

  /** Append one row — a frame, or the terminal row (`frame: null`, with `error` on a failure). */
  private async append(runId: string, frame: string | null, error: string | null): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await this.table.append(runId, { frame, error, createdAt: Date.now() });
        return;
      } catch (caught) {
        if (attempt >= APPEND_ATTEMPTS || !this.table.isUniqueViolation(caught)) throw caught;
      }
    }
  }

  /** Write out what is gathered, then a terminal row; raise a failure nobody saw. */
  private async terminate(runId: string, error: string | null): Promise<void> {
    const state = this.runWrites(runId);
    const flushed = this.flushText(runId, state);
    const ended = this.enqueue(runId, state, () => this.append(runId, null, error));
    await Promise.all([flushed, ended]);
    this.raiseFailure(state);
    this.release(runId, state);
    this.purgeInBackground();
  }

  /**
   * The run's writer. Writers opened for the same run in one process share what they are gathering,
   * so a delegated run's text (forwarded through a child writer) and its parent's next frame keep
   * the order they were written in.
   */
  open(runId: string): SinkWriter {
    return {
      write: async (chunk: Uint8Array) => {
        const state = this.runWrites(runId);
        this.raiseFailure(state);
        const line = decoder.decode(chunk);
        const text = this.flushMs > 0 ? textOf(line.trimEnd()) : null;
        if (text !== null) {
          state.text = (state.text ?? '') + text;
          // Counted from the FIRST gathered token, not the last: a steady stream still reaches the
          // table every `flushMs`, instead of being held for as long as the model keeps talking.
          if (state.timer === undefined) {
            state.timer = setTimeout(() => {
              state.timer = undefined;
              this.flushText(runId, state).catch((error: unknown) => {
                state.failure = { error };
              });
            }, this.flushMs);
          }
          return;
        }
        const flushed = this.flushText(runId, state);
        const appended = this.enqueue(runId, state, () => this.append(runId, line, null));
        await Promise.all([flushed, appended]);
      },
      flush: async () => {
        const state = this.runWrites(runId);
        const flushed = this.flushText(runId, state);
        await Promise.all([flushed, state.tail]);
        this.raiseFailure(state);
        this.release(runId, state);
      },
      end: () => this.terminate(runId, null),
      fail: (error: StreamError) =>
        this.terminate(runId, JSON.stringify({ code: error.code, message: error.message })),
    };
  }

  async *subscribe(runId: string): AsyncIterable<Uint8Array> {
    let cursor = 0;
    let quietSince = Date.now();
    while (true) {
      const rows = await this.table.read(runId, cursor, READ_PAGE);
      for (const row of rows) {
        cursor = row.seq;
        if (row.frame === null) {
          if (row.error !== null) {
            throw new AgentStreamError(JSON.parse(row.error) as StreamError);
          }
          return;
        }
        yield encoder.encode(row.frame);
      }
      if (rows.length > 0) {
        quietSince = Date.now();
        // A full page means there may be more already written: read on without waiting.
        if (rows.length >= READ_PAGE) continue;
      }
      await sleep(
        Date.now() - quietSince >= IDLE_AFTER_MS ? this.idlePollIntervalMs : this.pollIntervalMs,
      );
    }
  }

  /** Does the table hold anything for the run — a frame, or its end? */
  has(runId: string): Promise<boolean> {
    return this.table.has(runId);
  }

  async close(runId: string): Promise<void> {
    const state = this.writes.get(runId);
    if (state !== undefined) {
      if (state.timer !== undefined) clearTimeout(state.timer);
      state.timer = undefined;
      state.text = null;
      state.failure = undefined;
      await state.tail;
      this.writes.delete(runId);
    }
    await this.table.remove([runId]);
  }

  /**
   * Delete every run whose last write is older than `ttlSeconds` at `now` (epoch-ms) — ended runs
   * past their replay window and runs that crashed without ending alike. Returns how many runs went.
   * Safe from any replica, and from several at once. A no-op under `ttlSeconds: 0`.
   */
  async purgeExpired(now: number = Date.now()): Promise<number> {
    if (this.ttlSeconds <= 0) return 0;
    const lapsed = await this.table.lapsedRuns(now - this.ttlSeconds * 1000);
    for (let index = 0; index < lapsed.length; index += PURGE_CHUNK) {
      await this.table.remove(lapsed.slice(index, index + PURGE_CHUNK));
    }
    return lapsed.length;
  }

  /** {@link purgeExpired}, unawaited and at most once a minute. Its failure is not the run's. */
  private purgeInBackground(): void {
    if (!this.autoPurge || this.ttlSeconds <= 0) return;
    const now = Date.now();
    if (now - this.lastAutoPurge < AUTO_PURGE_EVERY_MS) return;
    this.lastAutoPurge = now;
    this.purgeExpired(now).catch(() => {
      // Retried after the next run ends; a purge that cannot run must not fail a finished turn.
    });
  }
}
