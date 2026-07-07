import {
  AgentStreamError,
  type SinkWriter,
  type StreamError,
  type TokenStreamSink,
} from '@dudousxd/nestjs-agent-core';
import type { RedisStreamClient } from './redis-stream-client.js';

/** Terminal marker stored at the state key: a normal end, or a failure carrying its {@link StreamError}. */
type Terminal = { t: 'end' } | { t: 'fail'; error: StreamError };

export interface RedisTokenStreamSinkOptions {
  /** Key/channel namespace. Defaults to `agent:stream`. Keys are `${keyPrefix}:${runId}:...`. */
  keyPrefix?: string;
}

/**
 * A multi-replica {@link TokenStreamSink} over Redis. Each run's chunks are appended to a Redis LIST
 * (so any replica can replay the whole stream so far — the same late-subscriber/reconnect guarantee
 * the in-process sink gives, but shared) and a per-run pub/sub channel wakes live subscribers. The
 * run's terminal state (end or {@link SinkWriter.fail}) lives in a marker key, so a subscriber that
 * connects after the run finished still sees the ending.
 *
 * The host supplies a {@link RedisStreamClient} adapter over its own Redis driver; `subscribe` needs
 * a connection in subscriber mode (see the client docs).
 */
export class RedisTokenStreamSink implements TokenStreamSink {
  private readonly keyPrefix: string;

  constructor(
    private readonly client: RedisStreamClient,
    options: RedisTokenStreamSinkOptions = {},
  ) {
    this.keyPrefix = options.keyPrefix ?? 'agent:stream';
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

  open(runId: string): SinkWriter {
    return {
      write: async (chunk: Uint8Array) => {
        await this.client.rpush(this.chunksKey(runId), toBase64(chunk));
        await this.client.publish(this.channel(runId), 'chunk');
      },
      end: async () => {
        await this.client.set(
          this.stateKey(runId),
          JSON.stringify({ t: 'end' } satisfies Terminal),
        );
        await this.client.publish(this.channel(runId), 'end');
      },
      fail: async (error: StreamError) => {
        await this.client.set(
          this.stateKey(runId),
          JSON.stringify({ t: 'fail', error } satisfies Terminal),
        );
        await this.client.publish(this.channel(runId), 'end');
      },
    };
  }

  async *subscribe(runId: string): AsyncIterable<Uint8Array> {
    // Notify bridge: the pub/sub handler resolves the current `wake` promise so the drain loop
    // re-reads. A promise is armed BEFORE each drain, so a publish arriving mid-drain is never lost.
    let resolveWake: (() => void) | null = null;
    const onMessage = () => {
      const resolve = resolveWake;
      resolveWake = null;
      resolve?.();
    };
    const unsubscribe = await this.client.subscribe(this.channel(runId), onMessage);
    try {
      let index = 0;
      while (true) {
        const wake = new Promise<void>((resolve) => {
          resolveWake = resolve;
        });
        const chunks = await this.client.lrange(this.chunksKey(runId), index, -1);
        for (const encoded of chunks) {
          index += 1;
          yield fromBase64(encoded);
        }
        const terminal = await this.readTerminal(runId);
        if (terminal !== null) {
          if (terminal.t === 'fail') {
            throw new AgentStreamError(terminal.error);
          }
          return;
        }
        await wake;
      }
    } finally {
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
