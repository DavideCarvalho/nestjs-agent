import type { ChannelStore } from '@dudousxd/nestjs-agent-core';

/**
 * The slice of a Redis client {@link RedisChannelStore} uses. An `ioredis` client has it as is
 * (`new RedisChannelStore(redis)`); adapt any other driver to these three commands.
 */
export interface RedisChannelClient {
  set(key: string, value: string, px: 'PX', ttlMs: number, nx: 'NX'): Promise<unknown>;
  set(key: string, value: string, px: 'PX', ttlMs: number): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<unknown>;
}

export interface RedisChannelStoreOptions {
  /** Prepended to every key. Default `agora:channel:`. */
  prefix?: string;
}

/**
 * A `ChannelStore` (text channels, `@dudousxd/nestjs-agent-channels`) shared by every replica, over
 * Redis: a claim is `SET … PX … NX`, so Redis decides the one winner and expires the key on its own.
 * Pass it as `AgentChannelsModule.forRoot({ store })`.
 */
export class RedisChannelStore implements ChannelStore {
  private readonly prefix: string;

  constructor(
    private readonly redis: RedisChannelClient,
    options: RedisChannelStoreOptions = {},
  ) {
    this.prefix = options.prefix ?? 'agora:channel:';
  }

  async claim(key: string, ttlMs: number): Promise<boolean> {
    return (await this.redis.set(`${this.prefix}${key}`, '', 'PX', ttl(ttlMs), 'NX')) === 'OK';
  }

  async get(key: string): Promise<string | null> {
    const value = await this.redis.get(`${this.prefix}${key}`);
    // A claim stores '' — a claimed key holds no value.
    return value === null || value === '' ? null : value;
  }

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    await this.redis.set(`${this.prefix}${key}`, value, 'PX', ttl(ttlMs));
  }

  async delete(key: string): Promise<void> {
    await this.redis.del(`${this.prefix}${key}`);
  }
}

const ttl = (ms: number) => Math.max(1, Math.round(ms));
