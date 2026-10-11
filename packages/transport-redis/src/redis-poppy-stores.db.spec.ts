// Integration: RedisPoppyStore / RedisPoppyConnectionStore against a REAL Redis (testcontainers),
// with an ioredis client passed as is. Runs only under `pnpm test:db`.
import {
  POPPY_CONNECTION_STORE_CONTRACT,
  POPPY_STORE_CONTRACT,
} from '@dudousxd/nestjs-agent-testing';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import Redis from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import { RedisPoppyConnectionStore } from './redis-poppy-connection-store.js';
import { RedisPoppyStore } from './redis-poppy-store.js';

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

describe('RedisPoppyStore on a real Redis — the Poppy store contract', () => {
  for (const contractCase of POPPY_STORE_CONTRACT) {
    it(contractCase.name, async () => contractCase.run({ store: new RedisPoppyStore(redis) }));
  }
});

describe('RedisPoppyConnectionStore on a real Redis — the Poppy connection store contract', () => {
  for (const contractCase of POPPY_CONNECTION_STORE_CONTRACT) {
    it(contractCase.name, async () =>
      contractCase.run({ store: new RedisPoppyConnectionStore(redis) }));
  }
});
