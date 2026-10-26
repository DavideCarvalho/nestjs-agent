import {
  AgentStreamError,
  type AgentStreamEvent,
  decodeStreamEvent,
  encodeStreamEvent,
} from '@dudousxd/nestjs-agent-core';
import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import { RedisTokenStreamSink } from './redis-token-stream-sink.js';

type Entry = [id: Buffer, fields: Buffer[]];

interface FakeRedis {
  redis: Redis;
  /** Round trips the writer side made: one per pipeline, one per direct command. */
  roundTrips: () => number;
  /** Connections `duplicate()` handed out that are still open. */
  openReaders: () => number;
  /** The stream's entries' payloads, in order. */
  stored: (key: string) => string[];
  drop: (key: string) => void;
}

/**
 * A minimal in-memory stand-in for the ioredis Streams surface the sink uses (`xadd`, `expire`,
 * `pipeline`, buffer `xreadBuffer` with `BLOCK`, `exists`, `duplicate`, `disconnect`, `del`).
 * Faithful enough to exercise replay + cursor + terminal semantics; a command takes a macrotask, as
 * a round trip does.
 */
function fakeRedisWith(
  ttls = new Map<string, number>(),
  /** `'resp3'` replies the way ioredis 6 does under `replyMapping: "resp3"`: a `{ key: entries }` map. */
  replyMapping: 'legacy' | 'resp3' = 'legacy',
): FakeRedis {
  const streams = new Map<string, Entry[]>();
  const appended = new Set<() => void>();
  let seq = 0;
  let roundTrips = 0;
  let openReaders = 0;
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  const xadd = (key: string, field: string, value: string | Buffer): string => {
    seq += 1;
    const id = `${seq}-0`;
    const entries = streams.get(key) ?? [];
    entries.push([Buffer.from(id), [Buffer.from(field), Buffer.from(value)]]);
    streams.set(key, entries);
    for (const wake of appended) wake();
    return id;
  };
  const expire = (key: string, seconds: number) => {
    ttls.set(key, seconds);
  };
  const read = (key: string, lastId: string): Entry[] => {
    const after = Number(lastId.split('-')[0]);
    return (streams.get(key) ?? []).filter(
      (entry) => Number(entry[0].toString().split('-')[0]) > after,
    );
  };
  const reply = (key: string, entries: Entry[]) =>
    replyMapping === 'resp3' ? { [key]: entries } : [[Buffer.from(key), entries]];
  const connection = (): Record<string, unknown> => {
    let closed = false;
    const aborts = new Set<() => void>();
    return {
      async xadd(key: string, _star: string, field: string, value: string | Buffer) {
        roundTrips += 1;
        await tick();
        return xadd(key, field, value);
      },
      async expire(key: string, seconds: number) {
        roundTrips += 1;
        await tick();
        expire(key, seconds);
        return 1;
      },
      pipeline() {
        const queued: Array<() => unknown> = [];
        const pipeline = {
          xadd(key: string, _star: string, field: string, value: string | Buffer) {
            queued.push(() => xadd(key, field, value));
            return pipeline;
          },
          expire(key: string, seconds: number) {
            queued.push(() => expire(key, seconds));
            return pipeline;
          },
          async exec() {
            roundTrips += 1;
            await tick();
            return queued.map((command) => [null, command()]);
          },
        };
        return pipeline;
      },
      async exists(key: string) {
        await tick();
        return streams.has(key) ? 1 : 0;
      },
      async xreadBuffer(...args: unknown[]): Promise<unknown> {
        // ('BLOCK', ms, 'STREAMS', key, lastId)
        const blockMs = Number(args[1]);
        const key = String(args[3]);
        const lastId = String(args[4]);
        if (closed) throw new Error('Connection is closed.');
        let entries = read(key, lastId);
        if (entries.length === 0) {
          await new Promise<void>((resolve, reject) => {
            const done = () => {
              clearTimeout(timer);
              appended.delete(done);
              aborts.delete(fail);
              resolve();
            };
            const fail = () => {
              clearTimeout(timer);
              appended.delete(done);
              reject(new Error('Connection is closed.'));
            };
            const timer = setTimeout(done, blockMs);
            appended.add(done);
            aborts.add(fail);
          });
          entries = read(key, lastId);
        }
        return entries.length === 0 ? null : reply(key, entries);
      },
      duplicate() {
        openReaders += 1;
        return connection();
      },
      disconnect() {
        if (closed) return;
        closed = true;
        openReaders -= 1;
        for (const fail of aborts) fail();
      },
      async del(key: string) {
        streams.delete(key);
        return 1;
      },
    };
  };
  return {
    // The sink only touches the methods above; the cast narrows the fake to the driver's shape.
    redis: connection() as unknown as Redis,
    roundTrips: () => roundTrips,
    openReaders: () => openReaders,
    stored: (key) => (streams.get(key) ?? []).map(([, fields]) => (fields[1] ?? '').toString()),
    drop: (key) => {
      streams.delete(key);
    },
  };
}

function fakeRedis(
  ttls = new Map<string, number>(),
  replyMapping: 'legacy' | 'resp3' = 'legacy',
): Redis {
  return fakeRedisWith(ttls, replyMapping).redis;
}

async function collect(iterable: AsyncIterable<Uint8Array>): Promise<string[]> {
  const decoder = new TextDecoder();
  const out: string[] = [];
  for await (const chunk of iterable) {
    out.push(decoder.decode(chunk));
  }
  return out;
}

describe('RedisTokenStreamSink', () => {
  it('reads the RESP3 map-shaped XREAD reply (ioredis 6 with replyMapping "resp3")', async () => {
    const sink = new RedisTokenStreamSink(fakeRedis(new Map(), 'resp3'));
    const encoder = new TextEncoder();
    const writer = await sink.open('run-resp3');
    await writer.write(encoder.encode('Hello'));
    await writer.write(encoder.encode(' world'));
    await writer.end();

    expect(await collect(sink.subscribe('run-resp3'))).toEqual(['Hello', ' world']);
  });

  it('replays every buffered chunk to a late subscriber, then ends cleanly', async () => {
    const sink = new RedisTokenStreamSink(fakeRedis());
    const encoder = new TextEncoder();
    const writer = await sink.open('run-1');
    await writer.write(encoder.encode('Hello'));
    await writer.write(encoder.encode(' world'));
    await writer.end();

    // Subscriber attaches AFTER the run finished — it must still replay all chunks.
    expect(await collect(sink.subscribe('run-1'))).toEqual(['Hello', ' world']);
  });

  it('surfaces a fail() terminal as a typed AgentStreamError after draining chunks', async () => {
    const sink = new RedisTokenStreamSink(fakeRedis());
    const encoder = new TextEncoder();
    const writer = await sink.open('run-2');
    await writer.write(encoder.encode('partial'));
    await writer.fail({ code: 'model_error', message: 'boom' });

    const decoder = new TextDecoder();
    const seen: string[] = [];
    await expect(
      (async () => {
        for await (const chunk of sink.subscribe('run-2')) {
          seen.push(decoder.decode(chunk));
        }
      })(),
    ).rejects.toMatchObject({ name: 'AgentStreamError', code: 'model_error' });
    expect(seen).toEqual(['partial']);
  });

  it('keeps runs isolated by key', async () => {
    const redis = fakeRedis();
    const sink = new RedisTokenStreamSink(redis);
    const encoder = new TextEncoder();
    const a = await sink.open('run-a');
    const b = await sink.open('run-b');
    await a.write(encoder.encode('AAA'));
    await b.write(encoder.encode('BBB'));
    await a.end();
    await b.end();

    expect(await collect(sink.subscribe('run-a'))).toEqual(['AAA']);
    expect(await collect(sink.subscribe('run-b'))).toEqual(['BBB']);
  });

  it('arms the TTL with every write, so a run that never ends still expires', async () => {
    const ttls = new Map<string, number>();
    const writer = new RedisTokenStreamSink(fakeRedis(ttls), { ttlSeconds: 60 }).open('run-c');
    await writer.write(new TextEncoder().encode('x'));
    expect(ttls.get('agent:sink:run-c')).toBe(60);
  });

  it('sets no TTL under ttlSeconds: 0 — EXPIRE 0 would delete the stream outright', async () => {
    const ttls = new Map<string, number>();
    const writer = new RedisTokenStreamSink(fakeRedis(ttls), { ttlSeconds: 0 }).open('run-d');
    await writer.write(new TextEncoder().encode('x'));
    await writer.end();
    expect(ttls.size).toBe(0);
  });

  it('sends a burst of text frames as one entry per round trip, in order with the frames around it', async () => {
    const fake = fakeRedisWith();
    const sink = new RedisTokenStreamSink(fake.redis);
    const writer = sink.open('run-burst');
    const tokens = Array.from({ length: 200 }, (_, i) => `t${i} `);
    for (const token of tokens) {
      await writer.write(encodeStreamEvent({ kind: 'text', text: token }));
    }
    await writer.write(encodeStreamEvent({ kind: 'reasoning', text: 'hm' }));
    await writer.write(encodeStreamEvent({ kind: 'text', text: 'tail' }));
    await writer.end();

    // A round trip for the first token, one for everything gathered while it was on the wire, one
    // for the reasoning frame and one for the end — not two commands per token.
    expect(fake.roundTrips()).toBeLessThanOrEqual(5);
    const frames = (await collect(sink.subscribe('run-burst'))).map(
      (chunk) => decodeStreamEvent(chunk.trimEnd()) as AgentStreamEvent,
    );
    const text = frames.filter((frame) => frame.kind === 'text').map((frame) => frame.text);
    expect(text.join('')).toBe(`${tokens.join('')}tail`);
    expect(text.at(-1)).toBe('tail');
    expect(frames.map((frame) => frame.kind).slice(-2)).toEqual(['reasoning', 'text']);
  });

  it('writes text frames out on flush() without ending the stream', async () => {
    const fake = fakeRedisWith();
    const sink = new RedisTokenStreamSink(fake.redis);
    const writer = sink.open('run-flush');
    await writer.write(encodeStreamEvent({ kind: 'text', text: 'a' }));
    await writer.write(encodeStreamEvent({ kind: 'text', text: 'b' }));
    expect(writer.flush).toBeTypeOf('function');
    await writer.flush?.();
    const stored = fake
      .stored('agent:sink:run-flush')
      .map((line) => decodeStreamEvent(line.trimEnd()) as AgentStreamEvent);
    expect(stored.map((event) => (event.kind === 'text' ? event.text : '')).join('')).toBe('ab');
  });

  it('stops following a stream that disappeared without a terminal', async () => {
    const fake = fakeRedisWith();
    const sink = new RedisTokenStreamSink(fake.redis, { blockMs: 5 });
    const writer = sink.open('run-gone');
    await writer.write(new TextEncoder().encode('partial'));
    const seen: string[] = [];
    const following = (async () => {
      for await (const chunk of sink.subscribe('run-gone'))
        seen.push(new TextDecoder().decode(chunk));
      return 'finished';
    })();
    await new Promise((resolve) => setTimeout(resolve, 20));
    fake.drop('agent:sink:run-gone');
    const outcome = await Promise.race([
      following,
      new Promise((resolve) => setTimeout(() => resolve('still following'), 500)),
    ]);
    expect(outcome).toBe('finished');
    expect(seen).toEqual(['partial']);
    expect(fake.openReaders()).toBe(0);
  });

  it('lets go of its blocking connection as soon as the subscriber aborts', async () => {
    const fake = fakeRedisWith();
    const sink = new RedisTokenStreamSink(fake.redis, { blockMs: 60_000 });
    const controller = new AbortController();
    const following = (async () => {
      for await (const _ of sink.subscribe('run-parked', { signal: controller.signal })) {
        // nothing is ever written
      }
      return 'finished';
    })();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fake.openReaders()).toBe(1);
    controller.abort();
    const outcome = await Promise.race([
      following,
      new Promise((resolve) => setTimeout(() => resolve('still blocked'), 500)),
    ]);
    expect(outcome).toBe('finished');
    expect(fake.openReaders()).toBe(0);
  });

  it('gives up on a stream that never appears within the TTL', async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeRedisWith();
      const sink = new RedisTokenStreamSink(fake.redis, { ttlSeconds: 2, blockMs: 100 });
      let finished = false;
      const following = (async () => {
        for await (const _ of sink.subscribe('run-never')) {
          // nothing is ever written
        }
        finished = true;
      })();
      await vi.advanceTimersByTimeAsync(1_900);
      expect(finished).toBe(false);
      await vi.advanceTimersByTimeAsync(300);
      await following;
      expect(finished).toBe(true);
      expect(fake.openReaders()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('follows a stream that first appears just inside the TTL', async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeRedisWith();
      const sink = new RedisTokenStreamSink(fake.redis, { ttlSeconds: 2, blockMs: 100 });
      const seen: string[] = [];
      const following = (async () => {
        for await (const chunk of sink.subscribe('run-late')) {
          seen.push(new TextDecoder().decode(chunk));
        }
      })();
      await vi.advanceTimersByTimeAsync(1_900);
      const writer = sink.open('run-late');
      const written = writer.write(new TextEncoder().encode('first'));
      await vi.advanceTimersByTimeAsync(3_000);
      await written;
      expect(seen).toEqual(['first']);
      const ended = writer.end();
      await vi.advanceTimersByTimeAsync(10);
      await ended;
      await following;
      expect(seen).toEqual(['first']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('AgentStreamError carries the structured code', () => {
    const error = new AgentStreamError({ code: 'x', message: 'y' });
    expect(error.code).toBe('x');
    expect(error.message).toBe('y');
  });
});
