import { type SQL, type TablesRelationalConfig, is } from 'drizzle-orm';
import {
  MySqlDatabase,
  type MySqlQueryResultHKT,
  type PreparedQueryHKTBase,
} from 'drizzle-orm/mysql-core';
import { PgDatabase, type PgQueryResultHKT } from 'drizzle-orm/pg-core';
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';
import { mysqlAgentTables } from './schema-mysql.js';
import { pgAgentTables } from './schema-pg.js';
import { agentSchema } from './schema.js';

/** The SQL dialects the stores in this package run on. */
export type AgentDialect = 'sqlite' | 'postgres' | 'mysql';

/** A Drizzle SQLite database, any driver (better-sqlite3, libsql, D1, …), sync or async. */
export type AgentSqliteDb = BaseSQLiteDatabase<
  'sync' | 'async',
  unknown,
  Record<string, unknown>,
  TablesRelationalConfig
>;
/** A Drizzle Postgres database, any driver (node-postgres, postgres.js, Neon, PGlite, …). */
export type AgentPgDb = PgDatabase<
  PgQueryResultHKT,
  Record<string, unknown>,
  TablesRelationalConfig
>;
/** A Drizzle MySQL database (mysql2, PlanetScale, …). */
export type AgentMySqlDb = MySqlDatabase<
  MySqlQueryResultHKT,
  PreparedQueryHKTBase,
  Record<string, unknown>,
  TablesRelationalConfig
>;

/**
 * The database handle every store here takes: a Drizzle database on SQLite, Postgres or MySQL. The
 * host owns the connection and passes the `drizzle(...)` instance in; the store tells the dialect
 * from the handle itself, and finds its tables in that dialect's schema
 * ({@link import('./schema.js').agentSchema}, {@link pgAgentSchema}, {@link mysqlAgentSchema}).
 */
export type AgentDrizzleDb = AgentSqliteDb | AgentPgDb | AgentMySqlDb;

/** Which dialect a Drizzle handle speaks. */
export function agentDialectOf(db: AgentDrizzleDb): AgentDialect {
  if (is(db, PgDatabase)) return 'postgres';
  if (is(db, MySqlDatabase)) return 'mysql';
  return 'sqlite';
}

/** The SQLite tables, which every dialect's table set mirrors key for key and column for column. */
export type AgentTables = typeof agentSchema;

/**
 * The agent tables in `dialect`, typed as the SQLite set.
 *
 * The three schemas declare the same property names over the same column names, and a Drizzle query
 * builder runs whatever table it is handed: the column objects carry their own driver mapping (a
 * `Date` becomes epoch-ms on SQLite, ISO on Postgres, `datetime` text on MySQL). So the stores are
 * written once, against the SQLite types, and run on the table set of the handle's dialect. The few
 * places the dialects really differ — `RETURNING`, upserts, raw statements — go through the helpers
 * below instead.
 */
export function agentTablesFor(dialect: AgentDialect, schema?: string): AgentTables {
  assertAgentSchema(dialect, schema);
  if (dialect === 'postgres') return pgAgentTables(schema) as unknown as AgentTables;
  if (dialect === 'mysql') return mysqlAgentTables(schema) as unknown as AgentTables;
  return agentSchema;
}

/** Where the stores' tables live: a database schema (Postgres) or database (MySQL) of their own. */
export interface AgentSchemaOptions {
  /**
   * The schema (Postgres) or database (MySQL) holding the agent tables. Every statement the stores
   * issue names it; the connection's `search_path` is never touched. Omit → the connection's
   * current schema / database, unqualified. Not supported on SQLite (the boot fails).
   */
  schema?: string;
}

const SCHEMA_NAME = /^[A-Za-z_][A-Za-z0-9_$]*$/;

/**
 * Throws when `schema` is not a plain identifier of at most 63 characters, or is set on SQLite, which
 * has no schemas. `undefined` always passes.
 */
export function assertAgentSchema(dialect: AgentDialect, schema: string | undefined): void {
  if (schema === undefined) return;
  if (typeof schema !== 'string' || !SCHEMA_NAME.test(schema) || schema.length > 63) {
    throw new Error(
      `nestjs-agent store: \`schema\` ${JSON.stringify(schema)} must match /^[A-Za-z_][A-Za-z0-9_$]*$/ and be at most 63 characters.`,
    );
  }
  if (dialect === 'sqlite') {
    throw new Error(
      `nestjs-agent store: \`schema: '${schema}'\` is set, but SQLite has no schemas. Remove \`schema\`, or use Postgres or MySQL.`,
    );
  }
}

/** `table` as `dialect` names it in `schema`: `"schema"."table"`, `` `db`.`table` ``, or just quoted. */
export function qualifiedTable(dialect: AgentDialect, table: string, schema?: string): string {
  const quote = (identifier: string) =>
    dialect === 'mysql' ? `\`${identifier}\`` : `"${identifier}"`;
  return schema === undefined ? quote(table) : `${quote(schema)}.${quote(table)}`;
}

/**
 * The handle as the SQLite query-builder type the stores are written against. A view for the type
 * checker only — see {@link agentTablesFor}; nothing SQLite-only (`run`/`all`/`get`, `returning` on
 * MySQL) may be called through it outside the helpers here.
 */
export function asBuilder(db: AgentDrizzleDb): AgentSqliteDb {
  return db as AgentSqliteDb;
}

/** A write statement that can be awaited and, outside MySQL, asked to `RETURNING` a column. */
interface Returnable {
  returning(fields: Record<string, unknown>): PromiseLike<unknown[]>;
}

/**
 * How many rows an UPDATE/DELETE/INSERT touched. `RETURNING` on SQLite and Postgres — the one answer
 * every driver of those gives alike — and the result header's `affectedRows` on MySQL, which has no
 * `RETURNING`.
 *
 * MySQL counts MATCHED rows for an update only while the connection has `FOUND_ROWS` (mysql2's
 * default); without it, an update that writes the value already there reports 0. A caller for whom
 * that difference matters re-reads the row rather than trusting a 0.
 */
export async function affectedRows(
  dialect: AgentDialect,
  statement: Returnable & PromiseLike<unknown>,
  column: unknown,
): Promise<number> {
  if (dialect !== 'mysql') {
    return (await statement.returning({ affected: column })).length;
  }
  return mysqlAffectedRows(await statement);
}

/** `affectedRows` off a MySQL driver's result (mysql2's `[ResultSetHeader, fields]`, or a header). */
export function mysqlAffectedRows(result: unknown): number {
  const header = Array.isArray(result) ? result[0] : result;
  const counts = header as { affectedRows?: unknown; rowsAffected?: unknown } | null | undefined;
  // mysql2 says `affectedRows`; PlanetScale's serverless driver says `rowsAffected`.
  const count = counts?.affectedRows ?? counts?.rowsAffected;
  return typeof count === 'number' ? count : 0;
}

/** Run a raw statement, discarding its result. */
export async function runSql(
  db: AgentDrizzleDb,
  dialect: AgentDialect,
  statement: SQL,
): Promise<void> {
  if (dialect === 'sqlite') {
    await (db as AgentSqliteDb).run(statement);
    return;
  }
  if (dialect === 'postgres') {
    await (db as AgentPgDb).execute(statement);
    return;
  }
  await (db as AgentMySqlDb).execute(statement);
}

/** Run a raw query and return its rows, whatever shape the driver hands them back in. */
export async function querySql<T>(
  db: AgentDrizzleDb,
  dialect: AgentDialect,
  statement: SQL,
): Promise<T[]> {
  if (dialect === 'sqlite') {
    return (db as AgentSqliteDb).all<T>(statement);
  }
  const result: unknown =
    dialect === 'postgres'
      ? await (db as AgentPgDb).execute(statement)
      : await (db as AgentMySqlDb).execute(statement);
  if (dialect === 'mysql') {
    // mysql2: [rows, fields]
    return (Array.isArray(result) ? result[0] : []) as T[];
  }
  // node-postgres: { rows }; postgres.js and friends: the rows themselves
  return (Array.isArray(result) ? result : ((result as { rows?: T[] }).rows ?? [])) as T[];
}

/**
 * Did this write lose a race it can simply retry? A duplicate on a primary-key or unique index —
 * Postgres `23505`, MySQL `ER_DUP_ENTRY` (1062), SQLite's constraint codes — or, on MySQL, being the
 * deadlock victim (`ER_LOCK_DEADLOCK`, 1213): two `INSERT … SELECT MAX(seq) + 1` into one run take
 * gap locks on the same range, and InnoDB settles that by rolling one of them back rather than by a
 * duplicate key. Walks the `cause` chain, since Drizzle wraps the driver's error.
 */
export function isUniqueViolation(error: unknown): boolean {
  for (let current = error; current !== null && typeof current === 'object'; ) {
    const { code, errno } = current as { code?: unknown; errno?: unknown };
    if (
      code === '23505' ||
      code === 'ER_DUP_ENTRY' ||
      errno === 1062 ||
      code === 'ER_LOCK_DEADLOCK' ||
      errno === 1213 ||
      (typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT'))
    ) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** An insert builder, as far as an upsert needs one. */
interface Upsertable {
  onConflictDoUpdate(config: {
    target: unknown;
    set: Record<string, unknown>;
  }): PromiseLike<unknown>;
}

/**
 * Insert, or update `set` on the row already holding `target`'s key: `ON CONFLICT … DO UPDATE` on
 * SQLite and Postgres, `ON DUPLICATE KEY UPDATE` on MySQL — which keys off EVERY unique index of the
 * table rather than a named target, so `target` must be the table's only key the row can collide on.
 */
export function upsert(
  dialect: AgentDialect,
  insert: Upsertable,
  target: unknown,
  set: Record<string, unknown>,
): PromiseLike<unknown> {
  if (dialect === 'mysql') {
    return (
      insert as unknown as {
        onDuplicateKeyUpdate(config: { set: Record<string, unknown> }): PromiseLike<unknown>;
      }
    ).onDuplicateKeyUpdate({ set });
  }
  return insert.onConflictDoUpdate({ target, set });
}
