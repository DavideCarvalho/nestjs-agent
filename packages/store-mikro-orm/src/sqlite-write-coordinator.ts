import { resolve } from 'node:path';
import type { EntityManager } from '@mikro-orm/core';
const pending = new Map<string, Promise<void>>();
/** Avoid blocking this process's event loop on synchronous SQLite BUSY while an async transaction
 * awaits its next statement. Database write locks and CAS remain authority across processes. */
export async function coordinateSqliteWrite<T>(
  em: EntityManager,
  work: () => Promise<T>,
): Promise<T> {
  if (
    !em.getPlatform().constructor.name.toLowerCase().includes('sqlite') ||
    em.getTransactionContext()
  )
    return work();
  const name = em.config.get('dbName');
  if (name === undefined) throw new Error('SQLite requires a configured database name');
  const key = name === ':memory:' ? `${em.config.get('contextName')}:memory` : resolve(name);
  const previous = pending.get(key) ?? Promise.resolve();
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => held);
  pending.set(key, tail);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (pending.get(key) === tail) pending.delete(key);
  }
}
