import {
  POPPY_CONNECTION_STORE_CONTRACT,
  POPPY_STORE_CONTRACT,
  poppyConversationFixture,
} from '@dudousxd/nestjs-agent-testing';
import type Redis from 'ioredis';
import { describe, expect, it } from 'vitest';
import {
  type RedisPoppyConnectionClient,
  RedisPoppyConnectionStore,
} from './redis-poppy-connection-store.js';
import { type RedisPoppyClient, RedisPoppyStore } from './redis-poppy-store.js';

/** An in-memory stand-in for the Redis commands the Poppy stores use: values with NX/PX/EX/KEEPTTL. */
class FakeRedis implements RedisPoppyClient, RedisPoppyConnectionClient {
  readonly values = new Map<string, { value: string; until: number }>();
  readonly sets = new Map<string, Set<string>>();

  private read(key: string): string | null {
    const found = this.values.get(key);
    if (!found) return null;
    if (found.until <= Date.now()) {
      this.values.delete(key);
      return null;
    }
    return found.value;
  }

  async get(key: string) {
    return this.read(key);
  }

  async mget(...keys: string[]) {
    return keys.map((key) => this.read(key));
  }

  async set(key: string, value: string, ...args: (string | number)[]): Promise<unknown> {
    if (args.includes('NX') && this.read(key) !== null) return null;
    const px = args.indexOf('PX');
    const ex = args.indexOf('EX');
    let until = Number.POSITIVE_INFINITY;
    if (px !== -1) until = Date.now() + Number(args[px + 1]);
    if (ex !== -1) until = Date.now() + Number(args[ex + 1]) * 1000;
    if (args.includes('KEEPTTL')) until = this.values.get(key)?.until ?? until;
    this.values.set(key, { value, until });
    return 'OK';
  }

  async del(...keys: string[]) {
    for (const key of keys) this.values.delete(key);
    return keys.length;
  }

  async incr(key: string) {
    const next = (Number(this.read(key)) || 0) + 1;
    this.values.set(key, { value: String(next), until: Number.POSITIVE_INFINITY });
    return next;
  }

  async sadd(key: string, ...members: string[]) {
    const set = this.sets.get(key) ?? new Set<string>();
    for (const member of members) set.add(member);
    this.sets.set(key, set);
    return members.length;
  }

  async srem(key: string, ...members: string[]) {
    for (const member of members) this.sets.get(key)?.delete(member);
    return members.length;
  }

  async smembers(key: string) {
    return [...(this.sets.get(key) ?? [])];
  }
}

describe('RedisPoppyStore — the Poppy store contract', () => {
  for (const contractCase of POPPY_STORE_CONTRACT) {
    it(contractCase.name, async () =>
      contractCase.run({ store: new RedisPoppyStore(new FakeRedis()) }));
  }

  it('prefixes its keys', async () => {
    const redis = new FakeRedis();
    const store = new RedisPoppyStore(redis, { prefix: 'app:' });
    await store.createConversation(poppyConversationFixture('cnv_1'));
    await store.appendEvent('cnv_1', { type: 'user_requested', reason: 'x' });
    expect([...redis.values.keys()].every((key) => key.startsWith('app:'))).toBe(true);
  });

  it('takes an ioredis client as is', () => {
    // Type-level: compiles only if the client has the slice the store uses.
    const fits = (client: Redis) => new RedisPoppyStore(client);
    expect(typeof fits).toBe('function');
  });
});

describe('RedisPoppyConnectionStore — the Poppy connection store contract', () => {
  for (const contractCase of POPPY_CONNECTION_STORE_CONTRACT) {
    it(contractCase.name, async () =>
      contractCase.run({ store: new RedisPoppyConnectionStore(new FakeRedis()) }));
  }

  it('expires a pending connect an hour after its own expiry, and keeps that on update', async () => {
    const redis = new FakeRedis();
    const store = new RedisPoppyConnectionStore(redis);
    const expiresAt = Date.now() + 60_000;
    await store.createPending({
      id: 'p1',
      owner: 'o',
      domain: 'd',
      issuer: 'i',
      organization: 'org',
      scope: '',
      actor: null,
      threadId: null,
      runId: null,
      toolCallId: null,
      flow: null,
      status: 'open',
      expiresAt,
      createdAt: 1,
    });
    const until = redis.values.get('agent:poppy-connections:pending:p1')?.until ?? 0;
    expect(until).toBeGreaterThanOrEqual(expiresAt + 3_600_000 - 1000);
    expect(until).toBeLessThanOrEqual(expiresAt + 3_600_000 + 2000);
    await store.updatePending('p1', { status: 'connected' });
    expect(redis.values.get('agent:poppy-connections:pending:p1')?.until).toBe(until);
  });

  it('takes an ioredis client as is', () => {
    const fits = (client: Redis) => new RedisPoppyConnectionStore(client);
    expect(typeof fits).toBe('function');
  });
});
