// Test-only (not exported from the package): runs a db spec on SQLite, Postgres and MySQL.
//
// `pnpm test:db`'s global setup (`vitest.db.global-setup.ts`) starts one container per dialect and
// injects its admin URL; every `openAgentOrm` here creates a THROWAWAY database in it, so spec files
// running in parallel never see each other's rows. Without Docker the Postgres/MySQL blocks skip with
// the reason in their title, and SQLite runs regardless.
import type { MikroORM as AnyOrm, EntitySchema, Options } from '@mikro-orm/core';
import { MySqlDriver, MikroORM as MySqlOrm } from '@mikro-orm/mysql';
import { MikroORM as PgOrm, PostgreSqlDriver } from '@mikro-orm/postgresql';
import { MikroORM, SqliteDriver } from '@mikro-orm/sqlite';
import mysql from 'mysql2/promise';
import pg from 'pg';
import { describe, inject } from 'vitest';
import { ensureAgentSchema } from '../ensure-schema';
import { AGENT_COLLATION, agentEntities } from '../entities';

declare module 'vitest' {
  export interface ProvidedContext {
    realDb: { postgres?: string; mysql?: string; skipReason?: string };
  }
}

export type Dialect = 'sqlite' | 'postgres' | 'mysql';
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

export interface ScratchDatabase {
  url: string;
  drop(): Promise<void>;
}

/** A new empty database on the dialect's shared server. */
export async function createScratchDatabase(
  dialect: 'postgres' | 'mysql',
): Promise<ScratchDatabase> {
  const admin = adminUrl(dialect);
  if (admin === undefined) throw new Error(`no ${dialect} server: ${unavailable(dialect)}`);
  const name = `agent_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`;
  const url = new URL(admin);
  url.pathname = `/${name}`;
  if (dialect === 'postgres') {
    const run = async (statement: string) => {
      const client = new pg.Client({ connectionString: admin });
      await client.connect();
      try {
        await client.query(statement);
      } finally {
        await client.end();
      }
    };
    await run(`create database "${name}"`);
    return {
      url: url.toString(),
      drop: () => run(`drop database if exists "${name}" with (force)`),
    };
  }
  const run = async (statement: string) => {
    const connection = await mysql.createConnection(admin);
    try {
      await connection.query(statement);
    } finally {
      await connection.end();
    }
  };
  await run(`create database \`${name}\``);
  return { url: url.toString(), drop: () => run(`drop database if exists \`${name}\``) };
}

/** The agent entities as a host on `dialect` registers them (`AGENT_ENTITIES` on MySQL). */
export function agentEntitiesFor(dialect: Dialect): EntitySchema[] {
  return agentEntities(dialect === 'mysql' ? { collation: AGENT_COLLATION } : {});
}

/** Another ORM over an EXISTING database (a second replica); closing it leaves the database. */
export async function openOrmAt(
  dialect: 'postgres' | 'mysql',
  url: string,
  entities: EntitySchema[] = agentEntitiesFor(dialect),
): Promise<MikroORM> {
  const init = dialect === 'postgres' ? PgOrm.init.bind(PgOrm) : MySqlOrm.init.bind(MySqlOrm);
  return (await init({
    driver: dialect === 'postgres' ? PostgreSqlDriver : MySqlDriver,
    clientUrl: url,
    entities,
    allowGlobalContext: true,
    pool: { min: 0, max: 5 },
  } as never)) as unknown as MikroORM;
}

export interface AgentOrmHandle {
  orm: MikroORM;
  dialect: Dialect;
  /**
   * A second ORM — its own pool — over the SAME database: what a second replica sees. SQLite's
   * `:memory:` lives in one connection, so there it is the same ORM. Closed by {@link close}.
   */
  replica(): Promise<MikroORM>;
  close(): Promise<void>;
}

/**
 * A MikroORM over a fresh database of `dialect`, configured the way a host would: MySQL gets the
 * entities with the shipped collation ({@link AGENT_COLLATION}, i.e. `AGENT_ENTITIES`), the others get
 * them without one. `ensureSchema` (default true) runs {@link ensureAgentSchema} first.
 */
export async function openAgentOrm(
  dialect: Dialect,
  options: { ensureSchema?: boolean; entities?: EntitySchema[]; config?: Partial<Options> } = {},
): Promise<AgentOrmHandle> {
  const entities =
    options.entities ?? agentEntities(dialect === 'mysql' ? { collation: AGENT_COLLATION } : {});
  let orm: MikroORM;
  let scratch: ScratchDatabase | undefined;
  const replicas: MikroORM[] = [];
  const connect = async (url: string): Promise<MikroORM> => {
    const init = dialect === 'postgres' ? PgOrm.init.bind(PgOrm) : MySqlOrm.init.bind(MySqlOrm);
    return (await init({
      driver: dialect === 'postgres' ? PostgreSqlDriver : MySqlDriver,
      clientUrl: url,
      entities,
      allowGlobalContext: true,
      pool: { min: 0, max: 5 },
      ...options.config,
    } as never)) as unknown as MikroORM;
  };
  if (dialect === 'sqlite') {
    orm = await MikroORM.init({
      driver: SqliteDriver,
      dbName: ':memory:',
      entities,
      allowGlobalContext: true,
      ...options.config,
    } as never);
  } else {
    scratch = await createScratchDatabase(dialect);
    orm = await connect(scratch.url);
  }
  if (options.ensureSchema !== false) {
    await ensureAgentSchema(orm);
  }
  // Bound now: `openFreshOrm` replaces `orm.close` with one that also drops the database.
  const closeOrm = orm.close.bind(orm);
  return {
    orm,
    dialect,
    replica: async () => {
      if (scratch === undefined) return orm;
      const second = await connect(scratch.url);
      replicas.push(second);
      return second;
    },
    close: async () => {
      for (const second of replicas) await second.close(true);
      await closeOrm(true);
      await scratch?.drop();
    },
  };
}

/** Run raw SQL with `?` placeholders on any dialect (MikroORM rewrites them for Postgres). */
export function rawSql<T = unknown>(
  orm: AnyOrm,
  statement: string,
  params: unknown[] = [],
): Promise<T> {
  return orm.em.fork().getConnection().execute(statement, params) as Promise<T>;
}

/**
 * A bare MikroORM over a NEW empty database of `dialect` — no schema — for a spec that builds or
 * heals the schema itself. Its `close(true)` also drops the database.
 */
export async function openFreshOrm(
  dialect: Dialect,
  config: Partial<Options> & { entities?: EntitySchema[] } = {},
): Promise<MikroORM> {
  const { entities, ...rest } = config;
  const handle = await openAgentOrm(dialect, {
    ensureSchema: false,
    ...(entities !== undefined ? { entities } : {}),
    config: rest,
  });
  const { orm } = handle;
  orm.close = async () => {
    await handle.close();
  };
  return orm;
}

/** The column names of `table`, on any dialect. */
export async function columnsOf(orm: AnyOrm, table: string): Promise<string[]> {
  const dialect = dialectOf(orm);
  const rows: { name: string }[] =
    dialect === 'sqlite'
      ? await rawSql(orm, `pragma table_info(${table})`)
      : await rawSql(
          orm,
          `select column_name as name from information_schema.columns where table_schema = ${dialect === 'mysql' ? 'database()' : 'current_schema()'} and table_name = ? order by ordinal_position`,
          [table],
        );
  return rows.map((row) => String(row.name));
}

/** The indexes on `table` (name + whether unique), on any dialect. */
export async function indexesOf(
  orm: AnyOrm,
  table: string,
): Promise<{ name: string; unique: boolean; columns: string[] }[]> {
  const dialect = dialectOf(orm);
  if (dialect === 'sqlite') {
    const list: { name: string; unique: number }[] = await rawSql(
      orm,
      `pragma index_list(${table})`,
    );
    const out = [];
    for (const index of list) {
      const info: { name: string }[] = await rawSql(orm, `pragma index_info(${index.name})`);
      out.push({ name: index.name, unique: index.unique === 1, columns: info.map((c) => c.name) });
    }
    return out;
  }
  if (dialect === 'postgres') {
    const rows: { name: string; def: string }[] = await rawSql(
      orm,
      'select indexname as name, indexdef as def from pg_indexes where schemaname = current_schema() and tablename = ?',
      [table],
    );
    return rows.map((row) => ({
      name: row.name,
      unique: /create unique index/i.test(row.def),
      columns: (row.def.match(/\(([^)]*)\)\s*$/)?.[1] ?? '')
        .split(',')
        .map((column) => column.trim().replaceAll('"', '')),
    }));
  }
  const rows: { name: string; non_unique: number | string; column_name: string }[] = await rawSql(
    orm,
    'select index_name as name, non_unique as non_unique, column_name as column_name from information_schema.statistics where table_schema = database() and table_name = ? order by index_name, seq_in_index',
    [table],
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

/** Which dialect an ORM talks to. */
export function dialectOf(orm: AnyOrm): Dialect {
  const platform = orm.em.getPlatform().constructor.name.toLowerCase();
  if (platform.includes('mysql') || platform.includes('maria')) return 'mysql';
  if (platform.includes('postgre')) return 'postgres';
  return 'sqlite';
}
