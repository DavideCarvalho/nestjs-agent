import {
  AgentStreamError,
  type SinkWriter,
  type StreamError,
  type TokenStreamSink,
} from '@dudousxd/nestjs-agent-core';
import type { Redis } from 'ioredis';

export interface RedisTokenStreamSinkOptions {
  /** Key namespace for the per-run streams. Default `agent:sink:`. */
  keyPrefix?: string;
  /**
   * TTL (seconds) applied to a run's stream once it ends/fails, so completed streams self-expire
   * instead of accumulating in Redis. A subscriber that reconnects within the window still replays.
   * Default 3600 (1h).
   */
  ttlSeconds?: number;
  /** `XREAD BLOCK` timeout (ms) between follow polls. Default 5000. Purely an internal cadence. */
  blockMs?: number;
}

// One-character field names keep each stream entry's payload minimal (one XADD per token delta).
const CHUNK_FIELD = 'c';
const END_FIELD = 'e';
const FAIL_FIELD = 'f';

/**
 * A cross-process {@link TokenStreamSink} backed by Redis Streams — the "data plane" for durable
 * agent turns whose model call runs on a WORKER pod while the SSE connection is served by an API
 * pod. The turn `XADD`s each delta to `agent:sink:<runId>`; a subscriber `XREAD`s from `0` so it
 * REPLAYS everything buffered so far (a reconnect or a subscriber that attaches after the run
 * started misses nothing), then blocks for live entries until an `end`/`fail` sentinel.
 *
 * The consumer supplies the ioredis client (so the lib stays Redis-driver-agnostic and reuses the
 * app's connection config). Blocking reads monopolise a connection, so each `subscribe` runs on a
 * short-lived `duplicate()` that is disconnected when the subscriber stops.
 */
export class RedisTokenStreamSink implements TokenStreamSink {
  private readonly keyPrefix: string;
  private readonly ttlSeconds: number;
  private readonly blockMs: number;

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

  open(runId: string): SinkWriter {
    const key = this.key(runId);
    return {
      write: async (chunk: Uint8Array) => {
        await this.redis.xadd(key, '*', CHUNK_FIELD, Buffer.from(chunk));
      },
      end: async () => {
        await this.redis.xadd(key, '*', END_FIELD, '1');
        await this.redis.expire(key, this.ttlSeconds);
      },
      fail: async (error: StreamError) => {
        await this.redis.xadd(key, '*', FAIL_FIELD, JSON.stringify(error));
        await this.redis.expire(key, this.ttlSeconds);
      },
    };
  }

  async *subscribe(runId: string): AsyncIterable<Uint8Array> {
    const key = this.key(runId);
    // Blocking XREAD holds the connection for the whole poll, so follow on a dedicated one.
    const reader = this.redis.duplicate();
    try {
      let lastId = '0';
      while (true) {
        const response = await reader.xreadBuffer(
          'BLOCK',
          this.blockMs,
          'STREAMS',
          key,
          lastId,
        );
        for (const entry of readEntries(response)) {
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
 * Flatten ioredis's `XREAD` buffer response — `[[key, [[id, [field, value, …]], …]], …] | null` —
 * into the entries we care about. Validated defensively at runtime (it crosses the Redis boundary)
 * rather than trusting the driver's loose typing.
 */
function readEntries(response: unknown): StreamEntry[] {
  if (!Array.isArray(response)) {
    return [];
  }
  const entries: StreamEntry[] = [];
  for (const stream of response) {
    if (!Array.isArray(stream) || !Array.isArray(stream[1])) {
      continue;
    }
    for (const item of stream[1]) {
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
