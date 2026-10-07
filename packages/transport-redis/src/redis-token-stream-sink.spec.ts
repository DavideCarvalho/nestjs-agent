import { AgentStreamError } from '@dudousxd/nestjs-agent-core';
import { describe, expect, it } from 'vitest';
import type { RedisStreamClient } from './redis-stream-client.js';
import { RedisTokenStreamSink } from './redis-token-stream-sink.js';

/** An in-memory stand-in for a Redis client, exercising the sink's list + pub/sub contract. */
class FakeRedis implements RedisStreamClient {
  private readonly lists = new Map<string, string[]>();
  private readonly values = new Map<string, string>();
  private readonly subs = new Map<string, Set<(message: string) => void>>();

  async rpush(key: string, value: string): Promise<void> {
    const list = this.lists.get(key) ?? [];
    list.push(value);
    this.lists.set(key, list);
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    const list = this.lists.get(key) ?? [];
    return stop === -1 ? list.slice(start) : list.slice(start, stop + 1);
  }

  async set(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async publish(channel: string, message: string): Promise<void> {
    for (const handler of this.subs.get(channel) ?? []) {
      handler(message);
    }
  }

  async subscribe(
    channel: string,
    onMessage: (message: string) => void,
  ): Promise<() => Promise<void>> {
    const handlers = this.subs.get(channel) ?? new Set();
    handlers.add(onMessage);
    this.subs.set(channel, handlers);
    return async () => {
      handlers.delete(onMessage);
    };
  }

  async del(...keys: string[]): Promise<void> {
    for (const key of keys) {
      this.lists.delete(key);
      this.values.delete(key);
    }
  }

  /** The TTL last armed per key — what EXPIRE would have set. */
  readonly ttls = new Map<string, number>();

  async expire(key: string, seconds: number): Promise<void> {
    this.ttls.set(key, seconds);
  }
}

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

async function collect(iterable: AsyncIterable<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let out = '';
  for await (const chunk of iterable) {
    out += decoder.decode(chunk);
  }
  return out;
}

describe('RedisTokenStreamSink — key expiry', () => {
  it('arms a TTL on the chunks on every write, and on both keys when the run ends', async () => {
    const redis = new FakeRedis();
    const writer = new RedisTokenStreamSink(redis).open('run-1');
    await writer.write(encode('hi'));
    expect(redis.ttls.get('agent:stream:run-1:chunks')).toBe(3600);
    await writer.end();
    expect(redis.ttls.get('agent:stream:run-1:state')).toBe(3600);
  });

  it('expires a failed run too, with the configured TTL', async () => {
    const redis = new FakeRedis();
    const writer = new RedisTokenStreamSink(redis, { ttlSeconds: 60 }).open('run-1');
    await writer.write(encode('hi'));
    await writer.fail({ code: 'boom', message: 'x' });
    expect(redis.ttls.get('agent:stream:run-1:chunks')).toBe(60);
    expect(redis.ttls.get('agent:stream:run-1:state')).toBe(60);
  });

  it('sets no TTL under ttlSeconds: 0', async () => {
    const redis = new FakeRedis();
    const writer = new RedisTokenStreamSink(redis, { ttlSeconds: 0 }).open('run-1');
    await writer.write(encode('hi'));
    await writer.end();
    expect(redis.ttls.size).toBe(0);
  });

  it('still streams through an adapter that predates expire', async () => {
    const redis = new FakeRedis();
    // Shadow the method with nothing, the way an adapter written before `expire` looks at runtime.
    Object.defineProperty(redis, 'expire', { value: undefined });
    const sink = new RedisTokenStreamSink(redis);
    const writer = sink.open('run-1');
    await writer.write(encode('ok'));
    await writer.end();
    expect(await collect(sink.subscribe('run-1'))).toBe('ok');
  });
});

describe('RedisTokenStreamSink', () => {
  it('replays buffered chunks for a late subscriber after the run ended', async () => {
    const sink = new RedisTokenStreamSink(new FakeRedis());
    const writer = sink.open('run-1');
    await writer.write(encode('hel'));
    await writer.write(encode('lo'));
    await writer.end();

    expect(await collect(sink.subscribe('run-1'))).toBe('hello');
  });

  it('surfaces a failed run as an AgentStreamError after replaying its chunks', async () => {
    const sink = new RedisTokenStreamSink(new FakeRedis());
    const writer = sink.open('run-2');
    await writer.write(encode('partial'));
    await writer.fail({ code: 'run_failed', message: 'boom' });

    const received: string[] = [];
    await expect(
      (async () => {
        const decoder = new TextDecoder();
        for await (const chunk of sink.subscribe('run-2')) {
          received.push(decoder.decode(chunk));
        }
      })(),
    ).rejects.toMatchObject({ code: 'run_failed', message: 'boom' });
    expect(received.join('')).toBe('partial');
  });

  it('streams live: a subscriber that connects first still follows writes to completion', async () => {
    const sink = new RedisTokenStreamSink(new FakeRedis());
    const collected = collect(sink.subscribe('run-3'));
    const writer = sink.open('run-3');
    await writer.write(encode('a'));
    await writer.write(encode('b'));
    await writer.end();

    expect(await collected).toBe('ab');
  });

  it('throws AgentStreamError (not a generic error) so callers can branch on it', async () => {
    const sink = new RedisTokenStreamSink(new FakeRedis());
    await sink.open('run-4').fail({ code: 'quota_exceeded', message: 'over budget' });
    const caught = await collect(sink.subscribe('run-4')).catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(AgentStreamError);
    if (caught instanceof AgentStreamError) {
      expect(caught.code).toBe('quota_exceeded');
    }
  });
});
