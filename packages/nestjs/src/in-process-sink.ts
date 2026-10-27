import {
  AgentStreamError,
  type SinkWriter,
  type StreamError,
  type SubscribeOptions,
  type TokenStreamSink,
} from '@dudousxd/nestjs-agent-core';

interface RunBuffer {
  chunks: Uint8Array[];
  ended: boolean;
  failure?: StreamError;
  notify: Set<() => void>;
  /** When the run last wrote anything, for the live-run TTL. */
  lastWriteAt: number;
  /** Drops the buffer: on the live-run TTL while the run streams, on the grace period once it ended. */
  expiry: ReturnType<typeof setTimeout> | undefined;
}

/**
 * How long a run that stopped writing without ending keeps its buffer — a turn on a crashed or
 * cancelled path that never reached `end()`. The same window the Redis sinks give a stream past its
 * last write.
 */
const LIVE_TTL_MS = 3_600_000;

/**
 * How long an ended run's buffer outlives its `end()`/`fail()`, for a subscriber that attaches just
 * after the turn finished. Short, because nothing reached through a request replays a finished run:
 * the service only attaches a caller to a run that is still its thread's active stream.
 */
const ENDED_GRACE_MS = 60_000;

/**
 * The default `TokenStreamSink`: buffers chunks per run in-process so a reconnecting subscriber
 * replays everything so far, then follows live. A run's buffer is dropped {@link ENDED_GRACE_MS}
 * after it ends, or {@link LIVE_TTL_MS} after its last write if it never does.
 *
 * Single-replica only. Because the buffer lives in one process's memory, a resume/reconnect that
 * lands on a different replica than the one running the turn finds an empty buffer — the stream
 * appears stalled. For multi-replica deployments, supply a shared-transport `TokenStreamSink`
 * (e.g. Redis pub/sub keyed by runId) via `AgentModule.forRoot({ sink })`.
 */
export class InProcessTokenStreamSink implements TokenStreamSink {
  private readonly runs = new Map<string, RunBuffer>();
  /** Subscribers of a run nothing has opened yet, woken by its `open()`. */
  private readonly waiting = new Map<string, Set<() => void>>();

  private buffer(runId: string): RunBuffer {
    let buf = this.runs.get(runId);
    if (buf === undefined) {
      buf = {
        chunks: [],
        ended: false,
        notify: new Set(),
        lastWriteAt: Date.now(),
        expiry: undefined,
      };
      this.runs.set(runId, buf);
      this.expireAfter(runId, buf, LIVE_TTL_MS);
      const waiters = this.waiting.get(runId);
      this.waiting.delete(runId);
      for (const resolve of waiters ?? []) {
        resolve();
      }
    }
    return buf;
  }

  private expireAfter(runId: string, buf: RunBuffer, ms: number): void {
    if (buf.expiry !== undefined) {
      clearTimeout(buf.expiry);
    }
    buf.expiry = setTimeout(() => {
      buf.expiry = undefined;
      const idle = Date.now() - buf.lastWriteAt;
      if (!buf.ended && idle < LIVE_TTL_MS) {
        this.expireAfter(runId, buf, LIVE_TTL_MS - idle);
        return;
      }
      this.drop(runId, buf);
    }, ms);
    buf.expiry.unref?.();
  }

  /** Forget the run, and let anyone still following it finish as if it had ended. */
  private drop(runId: string, buf: RunBuffer): void {
    if (buf.expiry !== undefined) {
      clearTimeout(buf.expiry);
      buf.expiry = undefined;
    }
    if (this.runs.get(runId) === buf) {
      this.runs.delete(runId);
    }
    buf.ended = true;
    this.wake(buf);
  }

  private wake(buf: RunBuffer): void {
    for (const resolve of buf.notify) {
      resolve();
    }
    buf.notify.clear();
  }

  private finish(runId: string, buf: RunBuffer): void {
    buf.ended = true;
    this.wake(buf);
    this.expireAfter(runId, buf, ENDED_GRACE_MS);
  }

  /**
   * The run's writer. Each call finds the run's buffer afresh, so a run that went quiet past the
   * live TTL (parked on a person) and then writes again starts a new buffer its next subscriber
   * follows, rather than writing into one nothing reads.
   */
  open(runId: string): SinkWriter {
    this.buffer(runId);
    return {
      write: (chunk: Uint8Array) => {
        const buf = this.buffer(runId);
        buf.chunks.push(chunk);
        buf.lastWriteAt = Date.now();
        this.wake(buf);
      },
      end: () => {
        this.finish(runId, this.buffer(runId));
      },
      fail: (error: StreamError) => {
        const buf = this.buffer(runId);
        buf.failure = error;
        this.finish(runId, buf);
      },
    };
  }

  async *subscribe(runId: string, options: SubscribeOptions = {}): AsyncIterable<Uint8Array> {
    const { signal } = options;
    let buf = this.runs.get(runId);
    while (buf === undefined) {
      // Not opened yet — the subscriber is early. Waits without creating the run, so a runId that
      // never streams leaves nothing behind once its subscriber goes.
      const waiters = this.waiting.get(runId) ?? new Set<() => void>();
      this.waiting.set(runId, waiters);
      let resolve: () => void = () => {};
      const opened = new Promise<void>((r) => {
        resolve = r;
      });
      waiters.add(resolve);
      try {
        if (!(await untilAborted(opened, signal))) {
          return;
        }
      } finally {
        waiters.delete(resolve);
        if (waiters.size === 0 && this.waiting.get(runId) === waiters) {
          this.waiting.delete(runId);
        }
      }
      buf = this.runs.get(runId);
    }
    let index = 0;
    while (true) {
      while (index < buf.chunks.length) {
        const chunk = buf.chunks[index];
        index += 1;
        if (chunk !== undefined) {
          yield chunk;
        }
      }
      if (buf.ended) {
        // Drain buffered chunks first, then raise the failure as a typed terminal.
        if (buf.failure !== undefined) {
          throw new AgentStreamError(buf.failure);
        }
        return;
      }
      const current = buf;
      let resolve: () => void = () => {};
      const woken = new Promise<void>((r) => {
        resolve = r;
      });
      current.notify.add(resolve);
      try {
        if (!(await untilAborted(woken, signal))) {
          return;
        }
      } finally {
        current.notify.delete(resolve);
      }
    }
  }

  close(runId: string): void {
    const buf = this.runs.get(runId);
    if (buf?.expiry !== undefined) {
      clearTimeout(buf.expiry);
    }
    this.runs.delete(runId);
  }
}

/** Resolves `true` once `promise` does, or `false` as soon as `signal` aborts. */
async function untilAborted(
  promise: Promise<void>,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  if (signal === undefined) {
    await promise;
    return true;
  }
  if (signal.aborted) {
    return false;
  }
  let onAbort: () => void = () => {};
  const aborted = new Promise<false>((resolve) => {
    onAbort = () => resolve(false);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([promise.then(() => true as const), aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
