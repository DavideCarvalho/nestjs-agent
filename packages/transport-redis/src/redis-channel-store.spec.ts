import { CHANNEL_STORE_CONTRACT } from '@dudousxd/nestjs-agent-testing';
import type Redis from 'ioredis';
import { describe, expect, it } from 'vitest';
import { type RedisChannelClient, RedisChannelStore } from './redis-channel-store.js';

/** An in-memory stand-in for the three Redis commands the store uses, with `PX` / `NX`. */
class FakeRedis implements RedisChannelClient {
  readonly entries = new Map<string, { value: string; expiresAt: number }>();

  async set(key: string, value: string, _px: 'PX', ttlMs: number, nx?: 'NX'): Promise<unknown> {
    const live = this.entries.get(key);
    if (nx === 'NX' && live !== undefined && live.expiresAt > Date.now()) return null;
    this.entries.set(key, { value, expiresAt: Date.now() + ttlMs });
    return 'OK';
  }

  async get(key: string): Promise<string | null> {
    const live = this.entries.get(key);
    return live !== undefined && live.expiresAt > Date.now() ? live.value : null;
  }

  async del(key: string): Promise<unknown> {
    return this.entries.delete(key) ? 1 : 0;
  }
}

describe('RedisChannelStore — the channel store contract', () => {
  for (const contractCase of CHANNEL_STORE_CONTRACT) {
    it(contractCase.name, async () =>
      contractCase.run({ store: new RedisChannelStore(new FakeRedis()) }));
  }

  it('prefixes its keys', async () => {
    const redis = new FakeRedis();
    await new RedisChannelStore(redis, { prefix: 'app:' }).set('q', 'v', 1000);
    expect([...redis.entries.keys()]).toEqual(['app:q']);
  });

  it('claims with SET NX PX, and stores with SET PX', async () => {
    const calls: unknown[][] = [];
    const values = new Map<string, string>();
    const redis = {
      async set(key: string, value: string, ...rest: unknown[]) {
        calls.push([key, value, ...rest]);
        if (rest.includes('NX') && values.has(key)) return null;
        values.set(key, value);
        return 'OK';
      },
      get: async (key: string) => values.get(key) ?? null,
      del: async (key: string) => (values.delete(key) ? 1 : 0),
    };
    const store = new RedisChannelStore(redis);
    expect(await store.claim('telegram:9', 5000)).toBe(true);
    expect(await store.claim('telegram:9', 5000)).toBe(false);
    expect(calls[0]).toEqual(['agora:channel:telegram:9', '', 'PX', 5000, 'NX']);
    await store.set('q', 'v', 1000);
    expect(calls[2]).toEqual(['agora:channel:q', 'v', 'PX', 1000]);
  });

  it('takes an ioredis client as is', () => {
    // Type-level: compiles only if the client has the slice the store uses.
    const fits = (client: Redis) => new RedisChannelStore(client);
    expect(typeof fits).toBe('function');
  });
});
