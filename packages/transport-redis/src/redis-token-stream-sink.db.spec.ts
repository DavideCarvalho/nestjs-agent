// Integration: RedisTokenStreamSink against a REAL Redis (testcontainers), exercising the parts a
// fake can't — real list replay, and live pub/sub delivery across two separate connections (a
// subscribed connection can't run other commands, so command + subscriber are distinct clients).
// Runs only under `pnpm test:db`.
import { AgentStreamError } from '@dudousxd/nestjs-agent-core';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RedisStreamClient } from './redis-stream-client.js';
import { RedisTokenStreamSink } from './redis-token-stream-sink.js';

let container: StartedRedisContainer;
let command: Redis;
let subscriber: Redis;
let sink: RedisTokenStreamSink;

/**
 * Adapts two ioredis connections to {@link RedisStreamClient}. Real Redis puts a connection into
 * subscriber mode where it may issue no other commands, so `subscribe` uses its own connection while
 * everything else uses the command connection — the split the interface docs call for.
 */
function ioredisClient(commandConn: Redis, subscriberConn: Redis): RedisStreamClient {
  return {
    rpush: async (key, value) => {
      await commandConn.rpush(key, value);
    },
    lrange: (key, start, stop) => commandConn.lrange(key, start, stop),
    set: async (key, value) => {
      await commandConn.set(key, value);
    },
    get: (key) => commandConn.get(key),
    publish: async (channel, message) => {
      await commandConn.publish(channel, message);
    },
    subscribe: async (channel, onMessage) => {
      const listener = (incoming: string, message: string) => {
        if (incoming === channel) {
          onMessage(message);
        }
      };
      subscriberConn.on('message', listener);
      await subscriberConn.subscribe(channel);
      return async () => {
        subscriberConn.off('message', listener);
        await subscriberConn.unsubscribe(channel);
      };
    },
    del: async (...keys) => {
      await commandConn.del(...keys);
    },
  };
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

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  container = await new RedisContainer('redis:7-alpine').start();
  command = new Redis(container.getConnectionUrl());
  subscriber = new Redis(container.getConnectionUrl());
  sink = new RedisTokenStreamSink(ioredisClient(command, subscriber));
});

afterAll(async () => {
  command?.disconnect();
  subscriber?.disconnect();
  await container?.stop();
});

describe('RedisTokenStreamSink (real Redis)', () => {
  it('replays buffered chunks from the Redis list for a late subscriber', async () => {
    const writer = sink.open('run-replay');
    await writer.write(encode('hel'));
    await writer.write(encode('lo'));
    await writer.end();

    expect(await collect(sink.subscribe('run-replay'))).toBe('hello');
  });

  it('surfaces a failed run as an AgentStreamError after replaying its chunks', async () => {
    const writer = sink.open('run-fail');
    await writer.write(encode('partial'));
    await writer.fail({ code: 'run_failed', message: 'boom' });

    const received: string[] = [];
    const caught = await (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of sink.subscribe('run-fail')) {
        received.push(decoder.decode(chunk));
      }
    })().catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(AgentStreamError);
    expect(received.join('')).toBe('partial');
  });

  it('delivers live writes to a subscriber over real pub/sub (across two connections)', async () => {
    const collected = collect(sink.subscribe('run-live'));
    // Let the real SUBSCRIBE round-trip complete before publishing, so the wake notifications land.
    await delay(150);
    const writer = sink.open('run-live');
    await writer.write(encode('a'));
    await writer.write(encode('b'));
    await writer.end();

    expect(await collected).toBe('ab');
  });

  it('close() drops the run keys from Redis', async () => {
    const writer = sink.open('run-close');
    await writer.write(encode('x'));
    await writer.end();
    await sink.close('run-close');

    expect(await command.exists('agent:stream:run-close:chunks')).toBe(0);
    expect(await command.exists('agent:stream:run-close:state')).toBe(0);
  });
});
