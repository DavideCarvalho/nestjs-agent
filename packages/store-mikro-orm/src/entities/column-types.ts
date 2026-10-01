import { type EntityProperty, type Platform, TextType } from '@mikro-orm/core';

/**
 * An unbounded text column on every dialect. MikroORM's `text` is `TEXT` everywhere, and on MySQL
 * `TEXT` is capped at 64 KB — a long assistant answer, a reasoning trace or a stack trace past that
 * fails the insert with `Data too long`. MySQL gets `LONGTEXT` (4 GB); every other dialect keeps
 * what `text` always rendered there, so an existing Postgres/SQLite schema has nothing to alter.
 */
export class LongTextType extends TextType {
  override getColumnType(prop: EntityProperty, platform: Platform): string {
    const name = platform.constructor.name.toLowerCase();
    return name.includes('mysql') || name.includes('maria')
      ? 'longtext'
      : super.getColumnType(prop, platform);
  }
}

/** A timestamp column with fractional seconds. */
export const DATETIME = {
  type: 'datetime',
  /**
   * Microseconds. MySQL's `datetime` defaults to WHOLE seconds, which is how two rows written in one
   * second came back in either order. Six rather than three because six is what Postgres's
   * `timestamptz` already is, so a Postgres schema has nothing to alter; SQLite ignores it.
   */
  length: 6,
} as const;

/**
 * The column options for an IDENTITY column — an actor, a tenant, a memory scope — given the
 * collation the host stamps string columns with.
 *
 * Who owns a row is decided by `=` on these columns, and under a case-insensitive collation (MySQL's
 * `utf8mb4_unicode_ci`, which {@link import('./index').AGENT_COLLATION} is) `'alice' = 'ALICE'`: two
 * actors whose refs differ only in case read each other's threads, usage and memories. Postgres and
 * SQLite compare them exactly, so these columns take the BINARY collation of the same character set
 * (`utf8mb4_bin`) — matching an id exactly everywhere — while every other string column keeps the
 * host's collation.
 */
export function identityCollation(collation: string | undefined): { collation?: string } {
  if (collation === undefined) return {};
  const charset = collation.split('_')[0];
  return { collation: `${charset}_bin` };
}
