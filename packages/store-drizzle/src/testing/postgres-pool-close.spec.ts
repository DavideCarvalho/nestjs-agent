import { EventEmitter } from 'node:events';
import type { Pool } from 'pg';
import { expect, it } from 'vitest';
import { trackPostgresPoolShutdown } from './postgres-pool-close.js';

it('waits for every client end event even when pg-pool resolves end before sockets close', async () => {
  const pool = new EventEmitter();
  const one = new EventEmitter();
  const two = new EventEmitter();
  Object.assign(pool, { end: async () => {} });
  const close = trackPostgresPoolShutdown(pool as unknown as Pool);
  pool.emit('connect', one);
  pool.emit('connect', two);
  let closed = false;
  const pending = close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(closed).toBe(false);
  one.emit('end');
  await Promise.resolve();
  await Promise.resolve();
  expect(closed).toBe(false);
  two.emit('end');
  await pending;
  expect(closed).toBe(true);
});
