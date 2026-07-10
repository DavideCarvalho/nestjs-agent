import { AgentStreamError } from '@dudousxd/nestjs-agent-core';
import type { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import { RedisTokenStreamSink } from './redis-token-stream-sink.js';

type Entry = [id: Buffer, fields: Buffer[]];

/**
 * A minimal in-memory stand-in for the ioredis Streams surface the sink uses (`xadd`, buffer
 * `xreadBuffer`, `duplicate`, `disconnect`, `del`, `expire`). Faithful enough to exercise replay +
 * cursor + terminal semantics; live-follow against a real Redis is covered by the integration run.
 */
function fakeRedis(): Redis {
  const streams = new Map<string, Entry[]>();
  let seq = 0;
  const client = {
    async xadd(key: string, _star: string, field: string, value: string | Buffer): Promise<string> {
      seq += 1;
      const id = `${seq}-0`;
      const entries = streams.get(key) ?? [];
      entries.push([Buffer.from(id), [Buffer.from(field), Buffer.from(value)]]);
      streams.set(key, entries);
      return id;
    },
    async xreadBuffer(...args: unknown[]): Promise<unknown> {
      // ('BLOCK', ms, 'STREAMS', key, lastId)
      const key = String(args[3]);
      const lastId = String(args[4]);
      const after = Number(lastId.split('-')[0]);
      const entries = (streams.get(key) ?? []).filter((entry) => {
        const idNum = Number(entry[0].toString().split('-')[0]);
        return idNum > after;
      });
      if (entries.length === 0) {
        return null;
      }
      return [[Buffer.from(key), entries]];
    },
    duplicate() {
      return client;
    },
    disconnect() {},
    async del() {
      return 1;
    },
    async expire() {
      return 1;
    },
  };
  // The sink only touches the methods above; the cast narrows the fake to the driver's shape.
  return client as unknown as Redis;
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

  it('AgentStreamError carries the structured code', () => {
    const error = new AgentStreamError({ code: 'x', message: 'y' });
    expect(error.code).toBe('x');
    expect(error.message).toBe('y');
  });
});
