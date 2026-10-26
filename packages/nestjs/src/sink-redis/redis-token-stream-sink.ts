import {
  AgentStreamError,
  type SinkWriter,
  type StreamError,
  type SubscribeOptions,
  type TokenStreamSink,
  encodeStreamEvent,
} from '@dudousxd/nestjs-agent-core';
import type { Redis } from 'ioredis';

export interface RedisTokenStreamSinkOptions {
  /** Key namespace for the per-run streams. Default `agent:sink:`. */
  keyPrefix?: string;
  /**
   * How long (seconds) a run's stream outlives its last write, so streams self-expire instead of
   * accumulating in Redis — ended runs past their replay window and runs that crashed without
   * ending alike (nothing calls `close()` on its own). A subscriber that reconnects within the window
   * still replays. Default 3600 (1h). `0` keeps the stream until `close()`.
   */
  ttlSeconds?: number;
  /** `XREAD BLOCK` timeout (ms) between follow polls. Default 5000. Purely an internal cadence. */
  blockMs?: number;
}

// One-character field names keep each stream entry's payload minimal.
const CHUNK_FIELD = 'c';
const END_FIELD = 'e';
const FAIL_FIELD = 'f';

const decoder = new TextDecoder();

/** The text of a chunk that is exactly one `{"kind":"text","text":…}` line, else `null`. */
function textOf(chunk: Uint8Array): string | null {
  const line = decoder.decode(chunk).trimEnd();
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
    /* not one event: written as it came */
  }
  return null;
}

/** One run's write side in this process: the text being gathered, and the sends already queued. */
interface RunWrites {
  text: string | null;
  /** A send of the gathered text is queued and has not started yet. */
  flushQueued: boolean;
  /** Settles when every send queued so far has been attempted. Never rejects. */
  tail: Promise<void>;
  pending: number;
  /** A gathered send that failed with nobody awaiting it — raised by the next call. */
  failure: { error: unknown } | undefined;
}

/**
 * A cross-process {@link TokenStreamSink} backed by Redis Streams — the "data plane" for durable
 * agent turns whose model call runs on a WORKER pod while the SSE connection is served by an API
 * pod. The turn `XADD`s its frames to `agent:sink:<runId>`; a subscriber `XREAD`s from `0` so it
 * REPLAYS everything buffered so far (a reconnect or a subscriber that attaches after the run
 * started misses nothing), then blocks for live entries until an `end`/`fail` sentinel — or until
 * the stream is gone (expired or closed) after it had entries.
 *
 * Consecutive `text` frames are gathered while the previous send is still on the wire and go out as
 * ONE `text` entry, so a model streaming faster than a Redis round trip costs one round trip per
 * batch rather than per token, and a slow stream still goes out a token at a time. Every subscriber
 * reads the same stored entries in the same order, so frame numbering stays exact across replicas.
 *
 * The consumer supplies the ioredis client (so the lib stays Redis-driver-agnostic and reuses the
 * app's connection config). Blocking reads monopolise a connection, so each `subscribe` runs on a
 * short-lived `duplicate()` that is disconnected when the subscriber stops.
 */
export class RedisTokenStreamSink implements TokenStreamSink {
  private readonly keyPrefix: string;
  private readonly ttlSeconds: number;
  private readonly blockMs: number;
  private readonly writes = new Map<string, RunWrites>();

  constructor(
    private readonly redis: Redis,
    options: RedisTokenStreamSinkOptions = {},
  ) {
    this.keyPrefix = options.keyPrefix ?? 'agent:sink:';
    this.ttlSeconds = options.ttlSeconds ?? 3600;
    this.blockMs = options.blockMs ?? 5000;
  }

  private key(runId: string): string {
    return `${this.keyPrefix}${runId}`;
  }

  private runWrites(runId: string): RunWrites {
    let state = this.writes.get(runId);
    if (state === undefined) {
      state = {
        text: null,
        flushQueued: false,
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

  /** Queue `work` behind every send already queued for the run, so entries land in call order. */
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

  /**
   * One round trip: the entries, in order, then the TTL re-armed — sliding from the run's last
   * write. `EXPIRE 0` would delete, so 0 skips it.
   */
  private async send(
    runId: string,
    entries: ReadonlyArray<readonly [string, string | Buffer]>,
  ): Promise<void> {
    const key = this.key(runId);
    const pipeline = this.redis.pipeline();
    for (const [field, value] of entries) {
      pipeline.xadd(key, '*', field, value);
    }
    if (this.ttlSeconds > 0) pipeline.expire(key, this.ttlSeconds);
    const results = (await pipeline.exec()) ?? [];
    for (const [error] of results) {
      if (error) throw error;
    }
  }

  /** The gathered text as one entry (nothing if there is none), followed by `entries`. */
  private drain(state: RunWrites): Array<readonly [string, Buffer]> {
    if (state.text === null) return [];
    const text = state.text;
    state.text = null;
    return [[CHUNK_FIELD, Buffer.from(encodeStreamEvent({ kind: 'text', text }))]];
  }

  /** Queue a send of the gathered text, unless one is already queued and has not started. */
  private queueText(runId: string, state: RunWrites): void {
    if (state.flushQueued) return;
    state.flushQueued = true;
    this.enqueue(runId, state, async () => {
      state.flushQueued = false;
      const entries = this.drain(state);
      if (entries.length > 0) await this.send(runId, entries);
    }).catch((error: unknown) => {
      state.failure ??= { error };
    });
  }

  /** Raise, once, a gathered send that failed with nobody awaiting it. */
  private raiseFailure(state: RunWrites): void {
    const failure = state.failure;
    if (failure !== undefined) {
      state.failure = undefined;
      throw failure.error;
    }
  }

  /** Queue the gathered text and then `entry`, as one send; raise a failure nobody saw. */
  private async write(runId: string, entry: readonly [string, string | Buffer]): Promise<void> {
    const state = this.runWrites(runId);
    this.raiseFailure(state);
    await this.enqueue(runId, state, () => this.send(runId, [...this.drain(state), entry]));
    this.raiseFailure(state);
    this.release(runId, state);
  }

  /**
   * The run's writer. Writers opened for the same run in one process share what they are gathering,
   * so a delegated run's text (forwarded through a child writer) and its parent's next frame keep
   * the order they were written in.
   */
  open(runId: string): SinkWriter {
    return {
      write: async (chunk: Uint8Array) => {
        const text = textOf(chunk);
        if (text === null) {
          await this.write(runId, [CHUNK_FIELD, Buffer.from(chunk)]);
          return;
        }
        const state = this.runWrites(runId);
        this.raiseFailure(state);
        state.text = (state.text ?? '') + text;
        this.queueText(runId, state);
      },
      flush: async () => {
        const state = this.runWrites(runId);
        this.queueText(runId, state);
        await state.tail;
        this.raiseFailure(state);
        this.release(runId, state);
      },
      end: () => this.write(runId, [END_FIELD, '1']),
      fail: (error: StreamError) => this.write(runId, [FAIL_FIELD, JSON.stringify(error)]),
    };
  }

  async *subscribe(runId: string, options: SubscribeOptions = {}): AsyncIterable<Uint8Array> {
    const { signal } = options;
    if (signal?.aborted) return;
    const key = this.key(runId);
    // Blocking XREAD holds the connection for the whole poll, so follow on a dedicated one — and
    // drop it on abort, which is the only way to cut a blocked read short.
    const reader = this.redis.duplicate();
    const onAbort = () => reader.disconnect();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      let lastId = '0';
      while (true) {
        let response: unknown;
        try {
          response = await reader.xreadBuffer('BLOCK', this.blockMs, 'STREAMS', key, lastId);
        } catch (error) {
          if (signal?.aborted) return;
          throw error;
        }
        const entries = readEntries(response);
        if (entries.length === 0) {
          // A stream that had entries and is now gone expired or was closed without a terminal
          // (its run crashed, or is parked past the TTL): nothing will ever be appended to it.
          if (lastId !== '0' && (await this.redis.exists(key)) === 0) return;
          continue;
        }
        for (const entry of entries) {
          lastId = entry.id;
          if (entry.field === CHUNK_FIELD && entry.value !== undefined) {
            yield new Uint8Array(entry.value);
          } else if (entry.field === END_FIELD) {
            return;
          } else if (entry.field === FAIL_FIELD && entry.value !== undefined) {
            throw new AgentStreamError(parseStreamError(entry.value.toString()));
          }
        }
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
      reader.disconnect();
    }
  }

  async close(runId: string): Promise<void> {
    await this.redis.del(this.key(runId));
  }
}

interface StreamEntry {
  id: string;
  field: string;
  value: Buffer | undefined;
}

/**
 * The per-stream entry lists of an `XREAD` reply. ioredis 5 (and ioredis 6 under its default
 * `replyMapping: "legacy"`) returns `[[key, entries], …]`; ioredis 6 with `replyMapping: "resp3"`
 * surfaces the RESP3 map as a plain object `{ [key]: entries }`. Accept both, so the sink works with
 * whatever client the app hands it.
 */
function streamEntryLists(response: unknown): unknown[] {
  if (Array.isArray(response)) {
    return response.map((stream) => (Array.isArray(stream) ? stream[1] : undefined));
  }
  if (typeof response === 'object' && response !== null && !Buffer.isBuffer(response)) {
    return Object.values(response);
  }
  return [];
}

/**
 * Flatten ioredis's `XREAD` buffer response — `[[key, [[id, [field, value, …]], …]], …] | null`,
 * or the RESP3 map form (see {@link streamEntryLists}) — into the entries we care about. Validated
 * defensively at runtime (it crosses the Redis boundary) rather than trusting the driver's loose
 * typing.
 */
function readEntries(response: unknown): StreamEntry[] {
  const entries: StreamEntry[] = [];
  for (const list of streamEntryLists(response)) {
    if (!Array.isArray(list)) {
      continue;
    }
    for (const item of list) {
      if (!Array.isArray(item) || item.length < 2) {
        continue;
      }
      const [id, fields] = item;
      if (!Buffer.isBuffer(id) || !Array.isArray(fields)) {
        continue;
      }
      const field = Buffer.isBuffer(fields[0]) ? fields[0].toString() : undefined;
      if (field === undefined) {
        continue;
      }
      entries.push({
        id: id.toString(),
        field,
        value: Buffer.isBuffer(fields[1]) ? fields[1] : undefined,
      });
    }
  }
  return entries;
}

/** Parse a `fail` sentinel's payload back into a {@link StreamError}, tolerating malformed JSON. */
function parseStreamError(raw: string): StreamError {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'code' in parsed &&
      'message' in parsed &&
      typeof parsed.code === 'string' &&
      typeof parsed.message === 'string'
    ) {
      return { code: parsed.code, message: parsed.message };
    }
  } catch {
    // fall through to the generic terminal below
  }
  return { code: 'stream_failed', message: raw };
}
