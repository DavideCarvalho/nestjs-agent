import type { MikroORM } from '@mikro-orm/core';

/**
 * Non-destructive schema management. `schema.update({ safe: true })` gives create +
 * add-column for free and never drops or alters existing columns — safe to run on boot
 * against a shared, multi-owner database.
 */
export async function ensureAgentSchema(orm: MikroORM, opts?: { safe?: boolean }): Promise<void> {
  await orm.schema.update({ safe: opts?.safe ?? true });
}
