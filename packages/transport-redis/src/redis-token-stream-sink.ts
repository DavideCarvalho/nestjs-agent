import {
  AgentStreamError,
  type SinkWriter,
  type StreamError,
  type SubscribeOptions,
  type TokenStreamSink,
  encodeStreamEvent,
} from '@dudousxd/nestjs-agent-core';
import type { RedisStreamClient } from './redis-stream-client.js';

/** Terminal marker stored at the state key: a normal end, or a failure carrying its {@link StreamError}. */
type Terminal = { t: 'end' } | { t: 'fail'; error: StreamError };

export interface RedisTokenStreamSinkOptions {
  /** Key/channel namespace. Defaults to `agent:stream`. Keys are `${keyPrefix}:${runId}:...`. */
  keyPrefix?: string;
  /**
   * How long (seconds) a run's keys outlive its last write, so streams self-expire instead of
   * accumulating in Redis — ended runs past their replay window and runs that crashed without
   * ending alike (nothing calls `close()` on its own). A subscriber that reconnects within the
   * window still replays. Default 3600 (1h). `0` keeps the keys until `close()`.
   */
  ttlSeconds?: number;
}

const DEFAULT_TTL_SECONDS = 3600;

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
 * A multi-replica {@link TokenStreamSink} over Redis. Each run's chunks are appended to a Redis LIST
 * (so any replica can replay the whole stream so far — the same late-subscriber/reconnect guarantee
 * the in-process sink gives, but shared) and a per-run pub/sub channel wakes live subscribers. The
 * run's terminal state (end or {@link SinkWriter.fail}) lives in a marker key, so a subscriber that
 * connects after the run finished still sees the ending.
 *
 * Consecutive `text` frames are gathered while the previous send is still on the wire and go out as
 * ONE `text` chunk, so a model streaming faster than a Redis round trip costs one send per batch
 * rather than per token, and a slow stream still goes out a token at a time. Every subscriber reads
 * the same stored list in the same order, so frame numbering stays exact across replicas.
 *
 * The host supplies a {@link RedisStreamClient} adapter over its own Redis driver; `subscribe` needs
 * a connection in subscriber mode (see the client docs).
 */
export class RedisTokenStreamSink implements TokenStreamSink {
  private readonly keyPrefix: string;
  private readonly ttlSeconds: number;
  private readonly writes = new Map<string, RunWrites>();

  constructor(
    private readonly client: RedisStreamClient,
    options: RedisTokenStreamSinkOptions = {},
  ) {
    this.keyPrefix = options.keyPrefix ?? 'agent:stream';
    this.ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  }

  private chunksKey(runId: string): string {
    return `${this.keyPrefix}:${runId}:chunks`;
  }

  private stateKey(runId: string): string {
    return `${this.keyPrefix}:${runId}:state`;
  }

  private channel(runId: string): string {
    return `${this.keyPrefix}:${runId}`;
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

  /** Queue `work` behind every send already queued for the run, so chunks land in call order. */
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

  /** The gathered text as one chunk (nothing if there is none). */
  private drain(state: RunWrites): Uint8Array[] {
    if (state.text === null) return [];
    const text = state.text;
    state.text = null;
    return [encodeStreamEvent({ kind: 'text', text })];
  }

  /**
   * Append `chunks` in order, then wake subscribers. The wake waits for the append, so a woken
   * subscriber always finds what it was woken for; the TTL re-arm rides alongside the wake.
   */
  private async append(runId: string, chunks: readonly Uint8Array[]): Promise<void> {
    if (chunks.length === 0) return;
    for (const chunk of chunks) {
      await this.client.rpush(this.chunksKey(runId), toBase64(chunk));
    }
    await Promise.all([
      this.expire(this.chunksKey(runId)),
      this.client.publish(this.channel(runId), 'chunk'),
    ]);
  }

  /** Queue a send of the gathered text, unless one is already queued and has not started. */
  private queueText(runId: string, state: RunWrites): void {
    if (state.flushQueued) return;
    state.flushQueued = true;
    this.enqueue(runId, state, async () => {
      state.flushQueued = false;
      await this.append(runId, this.drain(state));
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

  /** Queue the gathered text and then `work`; raise a failure nobody saw. */
  private async after(
    runId: string,
    work: (gathered: Uint8Array[]) => Promise<void>,
  ): Promise<void> {
    const state = this.runWrites(runId);
    this.raiseFailure(state);
    await this.enqueue(runId, state, () => work(this.drain(state)));
    this.raiseFailure(state);
    this.release(runId, state);
  }

  private async terminate(runId: string, terminal: Terminal): Promise<void> {
    await this.after(runId, async (gathered) => {
      for (const chunk of gathered) {
        await this.client.rpush(this.chunksKey(runId), toBase64(chunk));
      }
      await this.client.set(this.stateKey(runId), JSON.stringify(terminal));
      await this.expire(this.chunksKey(runId), this.stateKey(runId));
      await this.client.publish(this.channel(runId), 'end');
    });
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
          await this.after(runId, (gathered) => this.append(runId, [...gathered, chunk]));
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
      end: () => this.terminate(runId, { t: 'end' }),
      fail: (error: StreamError) => this.terminate(runId, { t: 'fail', error }),
    };
  }

  /** (Re)arm the TTL on `keys` — sliding from the run's last write. */
  private async expire(...keys: string[]): Promise<void> {
    // An adapter written against the interface before `expire` existed: keep streaming, unexpired.
    if (this.ttlSeconds <= 0 || typeof this.client.expire !== 'function') return;
    for (const key of keys) await this.client.expire(key, this.ttlSeconds);
  }

  async *subscribe(runId: string, options: SubscribeOptions = {}): AsyncIterable<Uint8Array> {
    const { signal } = options;
    if (signal?.aborted) return;
    // Notify bridge: the pub/sub handler resolves the current `wake` promise so the drain loop
    // re-reads. A promise is armed BEFORE each drain, so a publish arriving mid-drain is never lost.
    let resolveWake: (() => void) | null = null;
    // The terminal marker is only read when it can have changed: on attach (the run may already be
    // over), and once an `end` arrives.
    let checkTerminal = true;
    const onMessage = (message: string) => {
      if (message === 'end') checkTerminal = true;
      const resolve = resolveWake;
      resolveWake = null;
      resolve?.();
    };
    const onAbort = () => onMessage('abort');
    signal?.addEventListener('abort', onAbort, { once: true });
    const unsubscribe = await this.client.subscribe(this.channel(runId), onMessage);
    try {
      let index = 0;
      while (signal?.aborted !== true) {
        const wake = new Promise<void>((resolve) => {
          resolveWake = resolve;
        });
        const chunks = await this.client.lrange(this.chunksKey(runId), index, -1);
        for (const encoded of chunks) {
          index += 1;
          yield fromBase64(encoded);
        }
        if (checkTerminal) {
          checkTerminal = false;
          const terminal = await this.readTerminal(runId);
          if (terminal !== null) {
            // Chunks the run appended before its terminal, read after this drain's LRANGE.
            for (const encoded of await this.client.lrange(this.chunksKey(runId), index, -1)) {
              index += 1;
              yield fromBase64(encoded);
            }
            if (terminal.t === 'fail') {
              throw new AgentStreamError(terminal.error);
            }
            return;
          }
        }
        await wake;
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
      await unsubscribe();
    }
  }

  async close(runId: string): Promise<void> {
    await this.client.del(this.chunksKey(runId), this.stateKey(runId));
  }

  private async readTerminal(runId: string): Promise<Terminal | null> {
    const raw = await this.client.get(this.stateKey(runId));
    if (raw === null || raw === '') {
      return null;
    }
    return JSON.parse(raw) as Terminal;
  }
}

function toBase64(chunk: Uint8Array): string {
  return Buffer.from(chunk).toString('base64');
}

function fromBase64(encoded: string): Uint8Array {
  return new Uint8Array(Buffer.from(encoded, 'base64'));
}
