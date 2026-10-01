// Test-only (not exported from the package): runs a db spec on SQLite, Postgres and MySQL.
//
// `pnpm test:db`'s global setup (`vitest.db.global-setup.ts`) starts one container per dialect and
// injects its admin URL; every `openAgentDb` here creates a THROWAWAY database in it, so spec files
// running in parallel never see each other's rows. Without Docker the Postgres/MySQL blocks skip with
// the reason in their title, and SQLite runs regardless.
import Database from 'better-sqlite3';
import { type SQL, sql } from 'drizzle-orm';
import { drizzle as drizzleSqlite } from 'drizzle-orm/better-sqlite3';
import { drizzle as drizzleMysql } from 'drizzle-orm/mysql2';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import mysql from 'mysql2/promise';
import pg from 'pg';
import { describe, inject } from 'vitest';
import {
  type AgentDialect,
  type AgentDrizzleDb,
  type AgentSqliteDb,
  type AgentTables,
  agentTablesFor,
  asBuilder,
  querySql,
  runSql,
} from '../dialect.js';
import { ensureAgentSchema } from '../ensure-schema.js';
import { mysqlAgentSchema } from '../schema-mysql.js';
import { pgAgentSchema } from '../schema-pg.js';
import { agentSchema } from '../schema.js';

declare module 'vitest' {
  export interface ProvidedContext {
    realDb: { postgres?: string; mysql?: string; skipReason?: string };
  }
}

export type Dialect = AgentDialect;
export const DIALECTS: readonly Dialect[] = ['sqlite', 'postgres', 'mysql'];

function adminUrl(dialect: 'postgres' | 'mysql'): string | undefined {
  return inject('realDb')?.[dialect];
}

/** Why `dialect` cannot run here, or `undefined` when it can. */
export function unavailable(dialect: Dialect): string | undefined {
  if (dialect === 'sqlite' || adminUrl(dialect) !== undefined) return undefined;
  return inject('realDb')?.skipReason ?? `no ${dialect} server configured`;
}

/**
 * `describe` once per dialect. A dialect without a server is still listed — skipped, its title saying
 * why — so a run without Docker reads as "skipped", never as "passed".
 */
export function describeEachDialect(title: string, body: (dialect: Dialect) => void): void {
  for (const dialect of DIALECTS) {
    const reason = unavailable(dialect);
    if (reason === undefined) {
      describe(`${title} [${dialect}]`, () => body(dialect));
    } else {
      describe.skip(`${title} [${dialect}] — skipped: ${reason}`, () => body(dialect));
    }
  }
}

async function adminRun(dialect: 'postgres' | 'mysql', statement: string): Promise<void> {
  const admin = adminUrl(dialect);
  if (admin === undefined) throw new Error(`no ${dialect} server: ${unavailable(dialect)}`);
  if (dialect === 'postgres') {
    const client = new pg.Client({ connectionString: admin });
    await client.connect();
    try {
      await client.query(statement);
    } finally {
      await client.end();
    }
    return;
  }
  const connection = await mysql.createConnection(admin);
  try {
    await connection.query(statement);
  } finally {
    await connection.end();
  }
}

/** Every agent table, each before the tables it references. */
const RESET_ORDER = [
  'agent_tool_call',
  'agent_message',
  'agent_queued_message',
  'agent_token_usage',
  'agent_run',
  'agent_thread',
  'agent_model_pricing',
  'agent_memory',
  'rag_ingestion_log',
  'agent_confirm_token',
  'agent_stream_frame',
];

export interface AgentDbHandle {
  dialect: Dialect;
  /** The handle the stores take. */
  db: AgentDrizzleDb;
  /** The same handle as the query-builder type a spec writes fixtures with. */
  q: AgentSqliteDb;
  /** The dialect's agent tables. */
  t: AgentTables;
  /** Run a raw statement. */
  run(statement: SQL | string): Promise<void>;
  /** Run a raw query and return its rows. */
  rows<T = Record<string, unknown>>(statement: SQL | string): Promise<T[]>;
  /** Empty every agent table, children first — a fresh start for the next case, schema kept. */
  reset(): Promise<void>;
  /** A second handle — its own pool — on the SAME database (SQLite `:memory:`: the same handle). */
  replica(): Promise<AgentDrizzleDb>;
  close(): Promise<void>;
}

/**
 * A Drizzle handle on a fresh database of `dialect`, built the way a host builds one: the dialect's
 * schema object, foreign keys enforced on SQLite. `ensureSchema` (default true) runs
 * {@link ensureAgentSchema} first.
 */
export async function openAgentDb(
  dialect: Dialect,
  options: {
    ensureSchema?: boolean;
    mysqlFlags?: string[];
    logger?: { logQuery(query: string, params: unknown[]): void };
  } = {},
): Promise<AgentDbHandle> {
  const closers: Array<() => Promise<void>> = [];
  let connect: () => Promise<AgentDrizzleDb>;
  if (dialect === 'sqlite') {
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    const db = drizzleSqlite(sqlite, {
      schema: agentSchema,
      ...(options.logger !== undefined ? { logger: options.logger } : {}),
    }) as unknown as AgentDrizzleDb;
    closers.push(async () => {
      sqlite.close();
    });
    connect = async () => db;
  } else {
    const name = `agent_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`;
    const url = new URL(adminUrl(dialect) as string);
    url.pathname = `/${name}`;
    await adminRun(
      dialect,
      dialect === 'postgres' ? `create database "${name}"` : `create database \`${name}\``,
    );
    closers.push(() =>
      adminRun(
        dialect,
        dialect === 'postgres'
          ? `drop database if exists "${name}" with (force)`
          : `drop database if exists \`${name}\``,
      ),
    );
    connect = async () => {
      if (dialect === 'postgres') {
        const pool = new pg.Pool({ connectionString: url.toString(), max: 5 });
        closers.unshift(() => pool.end());
        return drizzlePg(pool, {
          schema: pgAgentSchema,
          ...(options.logger !== undefined ? { logger: options.logger } : {}),
        }) as unknown as AgentDrizzleDb;
      }
      const pool = mysql.createPool({
        uri: url.toString(),
        connectionLimit: 5,
        ...(options.mysqlFlags !== undefined ? { flags: options.mysqlFlags } : {}),
      });
      closers.unshift(() => pool.end());
      return drizzleMysql(pool, {
        schema: mysqlAgentSchema,
        mode: 'default',
        ...(options.logger !== undefined ? { logger: options.logger } : {}),
      }) as unknown as AgentDrizzleDb;
    };
  }
  const db = await connect();
  if (options.ensureSchema !== false) {
    await ensureAgentSchema(db);
  }
  const toSql = (statement: SQL | string) =>
    typeof statement === 'string' ? sql.raw(statement) : statement;
  return {
    dialect,
    db,
    q: asBuilder(db),
    t: agentTablesFor(dialect),
    run: (statement) => runSql(db, dialect, toSql(statement)),
    rows: (statement) => querySql(db, dialect, toSql(statement)),
    reset: async () => {
      for (const table of RESET_ORDER) await runSql(db, dialect, sql.raw(`DELETE FROM ${table}`));
    },
    replica: () => (dialect === 'sqlite' ? Promise.resolve(db) : connect()),
    close: async () => {
      for (const close of closers) await close();
    },
  };
}

/** The column names of `table`, in table order. */
export async function columnsOf(handle: AgentDbHandle, table: string): Promise<string[]> {
  const rows =
    handle.dialect === 'sqlite'
      ? await handle.rows<{ name: string }>(`PRAGMA table_info("${table}")`)
      : await handle.rows<{ name: string }>(
          `select column_name as name from information_schema.columns where table_schema = ${handle.dialect === 'mysql' ? 'database()' : 'current_schema()'} and table_name = '${table}' order by ordinal_position`,
        );
  return rows.map((row) => String(row.name));
}

/** The indexes on `table`: name, uniqueness and columns. */
export async function indexesOf(
  handle: AgentDbHandle,
  table: string,
): Promise<{ name: string; unique: boolean; columns: string[] }[]> {
  if (handle.dialect === 'sqlite') {
    const list = await handle.rows<{ name: string; unique: number }>(
      `PRAGMA index_list("${table}")`,
    );
    const out = [];
    for (const index of list) {
      const info = await handle.rows<{ name: string }>(`PRAGMA index_info("${index.name}")`);
      out.push({ name: index.name, unique: index.unique === 1, columns: info.map((c) => c.name) });
    }
    return out;
  }
  if (handle.dialect === 'postgres') {
    const rows = await handle.rows<{ name: string; def: string }>(
      `select indexname as name, indexdef as def from pg_indexes where schemaname = current_schema() and tablename = '${table}'`,
    );
    return rows.map((row) => ({
      name: row.name,
      unique: /create unique index/i.test(row.def),
      columns: (row.def.match(/\(([^)]*)\)\s*$/)?.[1] ?? '')
        .split(',')
        .map((column) => column.trim().replaceAll('"', '')),
    }));
  }
  const rows = await handle.rows<{
    name: string;
    non_unique: number | string;
    column_name: string;
  }>(
    `select index_name as name, non_unique as non_unique, column_name as column_name from information_schema.statistics where table_schema = database() and table_name = '${table}' order by index_name, seq_in_index`,
  );
  const byName = new Map<string, { name: string; unique: boolean; columns: string[] }>();
  for (const row of rows) {
    const entry = byName.get(row.name) ?? {
      name: row.name,
      unique: Number(row.non_unique) === 0,
      columns: [],
    };
    entry.columns.push(row.column_name);
    byName.set(row.name, entry);
  }
  return [...byName.values()];
}
