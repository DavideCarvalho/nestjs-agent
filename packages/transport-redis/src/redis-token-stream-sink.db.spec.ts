// Integration: RedisTokenStreamSink against a REAL Redis (testcontainers), exercising the parts a
// fake can't — real list replay, and live pub/sub delivery across two separate connections (a
// subscribed connection can't run other commands, so command + subscriber are distinct clients).
// Runs only under `pnpm test:db`.
import { AgentStreamError, encodeStreamEvent } from '@dudousxd/nestjs-agent-core';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RedisStreamClient } from './redis-stream-client.js';
import { RedisTokenStreamSink } from './redis-token-stream-sink.js';

let container: StartedRedisContainer;
let command: Redis;
let subscriber: Redis;
let admin: Redis;
let sink: RedisTokenStreamSink;

/**
 * Adapts two ioredis connections to {@link RedisStreamClient}. Real Redis puts a connection into
 * subscriber mode where it may issue no other commands, so `subscribe` uses its own connection while
 * everything else uses the command connection — the split the interface docs call for.
 */
function ioredisClient(commandConn: Redis, subscriberConn: Redis): RedisStreamClient {
  return {
    rpush: (key, value) => commandConn.rpush(key, value),
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
    expire: async (key, seconds) => {
      await commandConn.expire(key, seconds);
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

/** The adapter as written before `rpush` resolved to the length — the old docs' shape. */
function legacyAdapter(commandConn: Redis, subscriberConn: Redis): RedisStreamClient {
  return {
    ...ioredisClient(commandConn, subscriberConn),
    rpush: async (key, value) => {
      await commandConn.rpush(key, value);
    },
  };
}

/** What a writer before this change did per frame: RPUSH, EXPIRE, then a bare `chunk` wake. */
async function legacyWrite(runId: string, chunk: string): Promise<void> {
  await command.rpush(`agent:stream:${runId}:chunks`, Buffer.from(chunk).toString('base64'));
  await command.expire(`agent:stream:${runId}:chunks`, 3600);
  await command.publish(`agent:stream:${runId}`, 'chunk');
}

/** What a subscriber before this change did: `LRANGE` from its cursor on every message. */
async function legacySubscribe(runId: string): Promise<string> {
  const sub = new Redis(container.getConnectionUrl());
  let index = 0;
  let out = '';
  let ended = false;
  let wake: () => void = () => {};
  sub.on('message', (_channel: string, message: string) => {
    if (message === 'end') ended = true;
    wake();
  });
  await sub.subscribe(`agent:stream:${runId}`);
  try {
    for (;;) {
      const woken = new Promise<void>((resolve) => {
        wake = resolve;
      });
      for (const encoded of await command.lrange(`agent:stream:${runId}:chunks`, index, -1)) {
        index += 1;
        out += Buffer.from(encoded, 'base64').toString();
      }
      if (ended || (await command.get(`agent:stream:${runId}:state`)) !== null) {
        for (const encoded of await command.lrange(`agent:stream:${runId}:chunks`, index, -1)) {
          out += Buffer.from(encoded, 'base64').toString();
        }
        return out;
      }
      await woken;
    }
  } finally {
    sub.disconnect();
  }
}

/** Server-side call counts per command (`INFO commandstats`). */
async function commandStats(): Promise<Record<string, number>> {
  const stats: Record<string, number> = {};
  for (const line of (await admin.info('commandstats')).split('\n')) {
    const match = /^cmdstat_([\w|]+):calls=(\d+)/.exec(line.trim());
    if (match?.[1] !== undefined) stats[match[1]] = Number(match[2]);
  }
  return stats;
}

/** A subscriber connection of its own, so concurrent subscriptions in one test don't share one. */
function freshSink(options?: ConstructorParameters<typeof RedisTokenStreamSink>[1]) {
  const sub = new Redis(container.getConnectionUrl());
  return {
    sink: new RedisTokenStreamSink(ioredisClient(command, sub), options),
    dispose: () => sub.disconnect(),
  };
}

beforeAll(async () => {
  container = await new RedisContainer('redis:7-alpine').start();
  command = new Redis(container.getConnectionUrl());
  subscriber = new Redis(container.getConnectionUrl());
  admin = new Redis(container.getConnectionUrl());
  sink = new RedisTokenStreamSink(ioredisClient(command, subscriber));
});

afterAll(async () => {
  command?.disconnect();
  subscriber?.disconnect();
  admin?.disconnect();
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

  it('leaves an ended run with a TTL on both keys', async () => {
    const writer = sink.open('run-ttl');
    await writer.write(encode('x'));
    await writer.end();
    const chunksTtl = await command.ttl('agent:stream:run-ttl:chunks');
    const stateTtl = await command.ttl('agent:stream:run-ttl:state');
    expect(chunksTtl).toBeGreaterThan(0);
    expect(chunksTtl).toBeLessThanOrEqual(3600);
    expect(stateTtl).toBeGreaterThan(0);
  });

  it('close() drops the run keys from Redis', async () => {
    const writer = sink.open('run-close');
    await writer.write(encode('x'));
    await writer.end();
    await sink.close('run-close');

    expect(await command.exists('agent:stream:run-close:chunks')).toBe(0);
    expect(await command.exists('agent:stream:run-close:state')).toBe(0);
  });

  it('stops following a run whose keys expired without a terminal', async () => {
    const shortLived = new RedisTokenStreamSink(ioredisClient(command, subscriber), {
      ttlSeconds: 1,
    });
    await shortLived.open('run-expired').write(encode('partial'));
    const outcome = await Promise.race([
      collect(shortLived.subscribe('run-expired')),
      delay(5_000).then(() => 'still following'),
    ]);
    expect(outcome).toBe('partial');
    // A running stream's TTL carries one refresh period of headroom past the last write.
    for (
      let i = 0;
      i < 30 && (await command.exists('agent:stream:run-expired:chunks')) === 1;
      i++
    ) {
      await delay(100);
    }
    expect(await command.exists('agent:stream:run-expired:chunks')).toBe(0);
  });

  it('costs ~2 commands per streamed frame: RPUSH + PUBLISH, no LRANGE or EXPIRE per frame', async () => {
    const collected = collect(sink.subscribe('run-cost'));
    await delay(150);
    await admin.config('RESETSTAT');
    const writer = sink.open('run-cost');
    const tokens = Array.from({ length: 100 }, (_, i) => `t${i} `);
    for (const token of tokens) {
      await writer.write(encodeStreamEvent({ kind: 'text', text: token }));
      await delay(5);
    }
    await writer.end();
    const frames = (await collected).split('\n').filter(Boolean);
    const stats = await commandStats();
    const flushed = stats.rpush ?? 0;
    expect(flushed).toBeGreaterThan(20);
    expect(frames).toHaveLength(flushed);
    expect(stats.publish).toBe(flushed + 1);
    // On attach (before RESETSTAT) and once at the end: no LRANGE per frame.
    expect(stats.lrange ?? 0).toBeLessThanOrEqual(1);
    // First write, then both keys at the end.
    expect(stats.expire ?? 0).toBeLessThanOrEqual(3);
    expect(stats.multi ?? 0).toBe(0);
    const perFrame =
      Object.entries(stats)
        .filter(([name]) => !name.startsWith('config') && name !== 'info')
        .reduce((sum, [, calls]) => sum + calls, 0) / flushed;
    expect(perFrame).toBeLessThan(2.2);
  });

  it('delivers interleaved frames to a live subscriber in order, none lost or repeated', async () => {
    const collected = collect(sink.subscribe('run-order'));
    await delay(150);
    const writer = sink.open('run-order');
    const expected: string[] = [];
    for (let i = 0; i < 60; i++) {
      const frame = i % 7 === 0 ? `{"kind":"marker","n":${i}}\n` : null;
      if (frame === null) {
        await writer.write(encodeStreamEvent({ kind: 'text', text: `${i},` }));
        expected.push(`${i},`);
      } else {
        await writer.write(encode(frame));
        expected.push(`|${i}|`);
      }
    }
    await writer.end();
    const out = (await collected)
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const parsed = JSON.parse(line) as { kind: string; text?: string; n?: number };
        return parsed.kind === 'text' ? parsed.text : `|${parsed.n}|`;
      })
      .join('');
    expect(out).toBe(expected.join(''));
  });

  it('gives a subscriber that joins mid-stream, and one that reconnects, the full history', async () => {
    const writer = sink.open('run-late');
    for (let i = 0; i < 10; i++) await writer.write(encode(`${i},`));
    const first = freshSink();
    const late = collect(first.sink.subscribe('run-late'));
    await delay(50);
    for (let i = 10; i < 20; i++) await writer.write(encode(`${i},`));
    // A reconnect: a brand-new subscription from the start, while the run is still writing.
    const second = freshSink();
    const controller = new AbortController();
    let dropped = '';
    for await (const chunk of second.sink.subscribe('run-late', { signal: controller.signal })) {
      dropped += new TextDecoder().decode(chunk);
      if (dropped.endsWith('19,')) break;
    }
    const resumed = collect(second.sink.subscribe('run-late'));
    await delay(50);
    for (let i = 20; i < 30; i++) await writer.write(encode(`${i},`));
    await writer.end();
    const all = Array.from({ length: 30 }, (_, i) => `${i},`).join('');
    expect(await late).toBe(all);
    expect(await resumed).toBe(all);
    first.dispose();
    second.dispose();
  });

  it('reads the list when a published frame skips past what the subscriber has', async () => {
    let seen = '';
    const done = (async () => {
      for await (const chunk of sink.subscribe('run-gap')) seen += new TextDecoder().decode(chunk);
    })();
    await delay(150);
    const writer = sink.open('run-gap');
    await writer.write(encode('a'));
    // Appended with no publish at all (a wake lost in transit): the next frame's seq is past it.
    await command.rpush('agent:stream:run-gap:chunks', Buffer.from('b').toString('base64'));
    await writer.write(encode('c'));
    // Caught up while the run is still live — not only by the read that follows its end.
    for (let i = 0; i < 50 && seen !== 'abc'; i++) await delay(20);
    expect(seen).toBe('abc');
    await writer.end();
    await done;
    expect(seen).toBe('abc');
  });

  it('leaves a TTL on a run whose writer died mid-stream, and the keys go', async () => {
    const shortLived = new RedisTokenStreamSink(ioredisClient(command, subscriber), {
      ttlSeconds: 2,
    });
    const writer = shortLived.open('run-dead');
    await writer.write(encode('x'));
    await writer.write(encode('y'));
    const ttl = await command.pttl('agent:stream:run-dead:chunks');
    expect(ttl).toBeGreaterThan(0);
    // The TTL, plus one refresh period (a quarter of it) of headroom.
    expect(ttl).toBeLessThanOrEqual(3000);
    // The writer is never ended: the keys still expire.
    await delay(3_300);
    expect(await command.exists('agent:stream:run-dead:chunks')).toBe(0);
  });

  it('mixed versions: a subscriber of this version follows a writer from before it', async () => {
    const collected = collect(sink.subscribe('run-old-writer'));
    await delay(150);
    for (const part of ['o', 'l', 'd']) await legacyWrite('run-old-writer', part);
    await sink.open('run-old-writer').end();
    expect(await collected).toBe('old');
  });

  it('mixed versions: a subscriber from before this version follows a writer of it', async () => {
    const collected = legacySubscribe('run-old-subscriber');
    await delay(150);
    const writer = sink.open('run-old-subscriber');
    for (const part of ['n', 'e', 'w']) await writer.write(encode(part));
    await writer.end();
    expect(await collected).toBe('new');
  });

  it('mixed versions: an adapter whose rpush resolves to nothing still streams live', async () => {
    const sub = new Redis(container.getConnectionUrl());
    const legacy = new RedisTokenStreamSink(legacyAdapter(command, sub));
    const collected = collect(legacy.subscribe('run-old-adapter'));
    await delay(150);
    const writer = legacy.open('run-old-adapter');
    for (const part of ['v', 'o', 'i', 'd']) await writer.write(encode(part));
    await writer.end();
    expect(await collected).toBe('void');
    sub.disconnect();
  });
});
