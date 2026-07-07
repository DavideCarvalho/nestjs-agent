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
