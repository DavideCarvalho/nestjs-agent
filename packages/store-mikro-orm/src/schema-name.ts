import type { EntityManager, ForkOptions } from '@mikro-orm/core';

/** Where the agent tables live: a database schema (Postgres) or database (MySQL) of their own. */
export interface AgentSchemaOptions {
  /**
   * The schema (Postgres) or database (MySQL) holding the agent tables. Every statement the stores
   * issue names it (`em.fork({ schema })`, and qualified raw SQL); the connection's `search_path` is
   * never touched. Omit → the connection's current schema / database, unqualified. Not supported on
   * SQLite (the boot fails).
   */
  schema?: string;
}

const SCHEMA_NAME = /^[A-Za-z_][A-Za-z0-9_$]*$/;

/** The platform family of `em`. */
export function platformOf(em: EntityManager): 'mysql' | 'postgres' | 'sqlite' | 'other' {
  const platform = em.getPlatform().constructor.name.toLowerCase();
  if (platform.includes('mysql') || platform.includes('maria')) return 'mysql';
  if (platform.includes('postgre')) return 'postgres';
  if (platform.includes('sqlite') || platform.includes('libsql')) return 'sqlite';
  return 'other';
}

/**
 * Throws when `schema` is not a plain identifier of at most 63 characters, or is set on SQLite, which
 * has no schemas. `undefined` always passes.
 */
export function assertAgentSchema(em: EntityManager, schema: string | undefined): void {
  if (schema === undefined) return;
  if (typeof schema !== 'string' || !SCHEMA_NAME.test(schema) || schema.length > 63) {
    throw new Error(
      `nestjs-agent store: \`schema\` ${JSON.stringify(schema)} must match /^[A-Za-z_][A-Za-z0-9_$]*$/ and be at most 63 characters.`,
    );
  }
  if (platformOf(em) === 'sqlite') {
    throw new Error(
      `nestjs-agent store: \`schema: '${schema}'\` is set, but SQLite has no schemas. Remove \`schema\`, or use Postgres or MySQL.`,
    );
  }
}

/** A fork of `em` whose queries name `schema` (when set). */
export function forkIn(
  em: EntityManager,
  schema: string | undefined,
  options: ForkOptions = {},
): EntityManager {
  return em.fork(schema === undefined ? options : { ...options, schema });
}

/**
 * `table` for raw SQL: `"schema"."table"` (MySQL: `` `db`.`table` ``) with a schema, else the bare
 * name exactly as the stores always wrote it (`quoted` keeps their `"table"` spelling).
 */
export function tableIn(
  em: EntityManager,
  table: string,
  schema: string | undefined,
  quoted = false,
): string {
  const mysql = platformOf(em) === 'mysql';
  const quote = (identifier: string) => (mysql ? `\`${identifier}\`` : `"${identifier}"`);
  if (schema === undefined) return quoted ? `"${table}"` : table;
  return `${quote(schema)}.${quote(table)}`;
}
