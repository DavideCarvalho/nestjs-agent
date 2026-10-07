// Integration: RedisChannelStore against a REAL Redis (testcontainers), with an ioredis client
// passed as is. Runs only under `pnpm test:db`.
import { CHANNEL_STORE_CONTRACT } from '@dudousxd/nestjs-agent-testing';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import Redis from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import { RedisChannelStore } from './redis-channel-store.js';

let container: StartedRedisContainer;
let redis: Redis;

beforeAll(async () => {
  container = await new RedisContainer('redis:7-alpine').start();
  redis = new Redis(container.getConnectionUrl());
}, 120_000);

afterAll(async () => {
  redis?.disconnect();
  await container?.stop();
});

beforeEach(async () => {
  await redis.flushall();
});

describe('RedisChannelStore on a real Redis — the channel store contract', () => {
  for (const contractCase of CHANNEL_STORE_CONTRACT) {
    it(contractCase.name, async () => contractCase.run({ store: new RedisChannelStore(redis) }));
  }
});
