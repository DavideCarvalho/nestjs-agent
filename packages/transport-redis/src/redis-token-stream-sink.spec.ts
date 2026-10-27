import {
  AgentStreamError,
  type AgentStreamEvent,
  decodeStreamEvent,
  encodeStreamEvent,
} from '@dudousxd/nestjs-agent-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

  it('sends a burst of text frames as one chunk per send, in order with the frames around it', async () => {
    const redis = new CountingRedis();
    const sink = new RedisTokenStreamSink(redis);
    const writer = sink.open('run-burst');
    const tokens = Array.from({ length: 200 }, (_, i) => `t${i} `);
    for (const token of tokens) {
      await writer.write(encodeStreamEvent({ kind: 'text', text: token }));
    }
    await writer.write(encodeStreamEvent({ kind: 'reasoning', text: 'hm' }));
    await writer.write(encodeStreamEvent({ kind: 'text', text: 'tail' }));
    await writer.end();

    // The first token, what gathered while it was on the wire, the reasoning frame, the tail.
    expect(redis.calls.rpush).toBeLessThanOrEqual(4);
    expect(redis.calls.publish).toBeLessThanOrEqual(5);
    const frames = (await collect(sink.subscribe('run-burst')))
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => decodeStreamEvent(line) as AgentStreamEvent);
    const text = frames.filter((frame) => frame.kind === 'text').map((frame) => frame.text);
    expect(text.join('')).toBe(`${tokens.join('')}tail`);
    expect(frames.map((frame) => frame.kind).slice(-2)).toEqual(['reasoning', 'text']);
  });

  it('reads the terminal marker only on attach and once the run ends, not on every wake', async () => {
    const redis = new CountingRedis();
    const sink = new RedisTokenStreamSink(redis);
    const collected = collect(sink.subscribe('run-live'));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const writer = sink.open('run-live');
    for (let i = 0; i < 20; i++) {
      await writer.write(encode(`frame${i}\n`));
    }
    await writer.end();
    expect((await collected).split('\n').filter(Boolean)).toHaveLength(20);
    expect(redis.calls.get).toBe(2);
  });

  it('writes gathered text frames out on flush() without ending the stream', async () => {
    const redis = new CountingRedis();
    const sink = new RedisTokenStreamSink(redis);
    const writer = sink.open('run-flush');
    await writer.write(encodeStreamEvent({ kind: 'text', text: 'a' }));
    await writer.write(encodeStreamEvent({ kind: 'text', text: 'b' }));
    expect(writer.flush).toBeTypeOf('function');
    await writer.flush?.();
    const stored = (await redis.lrange('agent:stream:run-flush:chunks', 0, -1)).map(
      (encoded) =>
        decodeStreamEvent(Buffer.from(encoded, 'base64').toString().trimEnd()) as AgentStreamEvent,
    );
    expect(stored.map((event) => (event.kind === 'text' ? event.text : '')).join('')).toBe('ab');
    expect(await redis.get('agent:stream:run-flush:state')).toBeNull();
  });

  it('keeps the chunks a run appended between a drain and the terminal it then read', async () => {
    // The run finishes while the subscriber is between its LRANGE and its read of the marker.
    class RacingRedis extends FakeRedis {
      private raced = false;
      override async lrange(key: string, start: number, stop: number): Promise<string[]> {
        const chunks = await super.lrange(key, start, stop);
        if (!this.raced) {
          this.raced = true;
          await this.rpush(key, Buffer.from('late').toString('base64'));
          await this.set('agent:stream:run-race:state', JSON.stringify({ t: 'end' }));
        }
        return chunks;
      }
    }
    const sink = new RedisTokenStreamSink(new RacingRedis());
    expect(await collect(sink.subscribe('run-race'))).toBe('late');
  });

  it('stops waiting for a run that never writes once the subscriber aborts', async () => {
    const redis = new CountingRedis();
    const sink = new RedisTokenStreamSink(redis);
    const controller = new AbortController();
    const following = (async () => {
      for await (const _ of sink.subscribe('run-parked', { signal: controller.signal })) {
        // nothing is ever written
      }
      return 'finished';
    })();
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    const outcome = await Promise.race([
      following,
      new Promise((resolve) => setTimeout(() => resolve('still waiting'), 200)),
    ]);
    expect(outcome).toBe('finished');
    expect(redis.subscribers()).toBe(0);
  });
});

/** Follows `runId` in the background, recording what arrives and whether the iterable finished. */
function follow(sink: RedisTokenStreamSink, runId: string) {
  const state = { seen: '', finished: false };
  const done = (async () => {
    for await (const chunk of sink.subscribe(runId)) state.seen += new TextDecoder().decode(chunk);
    state.finished = true;
  })();
  return { state, done };
}

describe('RedisTokenStreamSink — a run that is gone', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stops following a run that never writes once its TTL has passed', async () => {
    vi.useFakeTimers();
    const redis = new CountingRedis();
    const sink = new RedisTokenStreamSink(redis, { ttlSeconds: 2 });
    const { state, done } = follow(sink, 'run-silent');
    await vi.advanceTimersByTimeAsync(1_900);
    expect(state.finished).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    await done;
    expect(state.finished).toBe(true);
    expect(redis.subscribers()).toBe(0);
  });

  it('stops following a run whose keys expired without a terminal', async () => {
    vi.useFakeTimers();
    const redis = new FakeRedis();
    const sink = new RedisTokenStreamSink(redis, { ttlSeconds: 2 });
    await sink.open('run-crashed').write(encode('partial'));
    const { state, done } = follow(sink, 'run-crashed');
    await vi.advanceTimersByTimeAsync(2_000);
    await redis.del('agent:stream:run-crashed:chunks');
    await vi.advanceTimersByTimeAsync(100);
    await done;
    expect(state).toEqual({ seen: 'partial', finished: true });
  });

  it('keeps following a run that writes again before a whole TTL passes', async () => {
    vi.useFakeTimers();
    const sink = new RedisTokenStreamSink(new FakeRedis(), { ttlSeconds: 2 });
    const writer = sink.open('run-slow');
    const { state, done } = follow(sink, 'run-slow');
    for (const part of ['a', 'b', 'c']) {
      await vi.advanceTimersByTimeAsync(1_500);
      await writer.write(encode(part));
    }
    await vi.advanceTimersByTimeAsync(1_500);
    expect(state).toEqual({ seen: 'abc', finished: false });
    await writer.end();
    await done;
    expect(state).toEqual({ seen: 'abc', finished: true });
  });

  it('picks up chunks whose wake was lost instead of ending the run', async () => {
    vi.useFakeTimers();
    const redis = new FakeRedis();
    const sink = new RedisTokenStreamSink(redis, { ttlSeconds: 2 });
    const { state, done } = follow(sink, 'run-lossy');
    await vi.advanceTimersByTimeAsync(10);
    // Appended straight to the list, with no publish to wake the subscriber.
    await redis.rpush('agent:stream:run-lossy:chunks', Buffer.from('late').toString('base64'));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(state).toEqual({ seen: 'late', finished: false });
    await sink.open('run-lossy').end();
    await done;
    expect(state.finished).toBe(true);
  });

  it('stops following a run once close() drops its keys, even under ttlSeconds: 0', async () => {
    const redis = new CountingRedis();
    const sink = new RedisTokenStreamSink(redis, { ttlSeconds: 0 });
    await sink.open('run-closed').write(encode('partial'));
    const { state, done } = follow(sink, 'run-closed');
    await new Promise((resolve) => setTimeout(resolve, 10));
    await sink.close('run-closed');
    await Promise.race([done, new Promise((resolve) => setTimeout(resolve, 200))]);
    expect(state).toEqual({ seen: 'partial', finished: true });
    expect(redis.subscribers()).toBe(0);
  });
});

/** {@link FakeRedis} with a round trip's worth of latency per command, counting each. */
class CountingRedis extends FakeRedis {
  readonly calls = { rpush: 0, publish: 0, get: 0, lrange: 0 };
  private live = 0;
  private readonly tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  override async rpush(key: string, value: string): Promise<void> {
    this.calls.rpush += 1;
    await this.tick();
    await super.rpush(key, value);
  }

  override async publish(channel: string, message: string): Promise<void> {
    this.calls.publish += 1;
    await this.tick();
    await super.publish(channel, message);
  }

  override async get(key: string): Promise<string | null> {
    this.calls.get += 1;
    await this.tick();
    return super.get(key);
  }

  override async lrange(key: string, start: number, stop: number): Promise<string[]> {
    this.calls.lrange += 1;
    await this.tick();
    return super.lrange(key, start, stop);
  }

  override async subscribe(
    channel: string,
    onMessage: (message: string) => void,
  ): Promise<() => Promise<void>> {
    const unsubscribe = await super.subscribe(channel, onMessage);
    this.live += 1;
    return async () => {
      this.live -= 1;
      await unsubscribe();
    };
  }

  subscribers(): number {
    return this.live;
  }
}
