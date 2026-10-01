import { type Column, type SQL, getTableName, sql } from 'drizzle-orm';
import { getTableConfig as mysqlTableConfig } from 'drizzle-orm/mysql-core';
import { getTableConfig as pgTableConfig } from 'drizzle-orm/pg-core';
import { getTableConfig as sqliteTableConfig } from 'drizzle-orm/sqlite-core';
import {
  type AgentDialect,
  type AgentDrizzleDb,
  type AgentMySqlDb,
  type AgentPgDb,
  agentDialectOf,
  agentTablesFor,
  querySql,
  runSql,
} from './dialect.js';

/**
 * Creates the agent tables a database lacks, adds the columns and indexes an existing one lacks, and
 * never drops or alters anything — safe to run on every boot against a shared database. SQLite,
 * Postgres and MySQL alike, with no drizzle-kit and no migration files.
 *
 * The DDL is rendered from the dialect's Drizzle schema ({@link import('./schema.js').agentSchema},
 * {@link import('./schema-pg.js').pgAgentSchema}, {@link import('./schema-mysql.js').mysqlAgentSchema})
 * rather than written out by hand, so the tables this creates are the tables the stores query, column
 * for column, and a column added to a schema later reaches every database that is already running
 * without a list of `ALTER`s to keep in step. A column added later must therefore be nullable or
 * carry a default — an existing table cannot take a `NOT NULL` column without one.
 *
 * On Postgres and MySQL it runs under a cross-replica lock (`pg_advisory_xact_lock`, `get_lock`),
 * held on one connection for the whole run: several replicas booting an empty database at once would
 * otherwise race their `CREATE TABLE IF NOT EXISTS` — which Postgres does not make race-safe — and
 * all but one fail. On Postgres the whole heal is also one transaction, so it lands entirely or not
 * at all.
 */
export async function ensureAgentSchema(db: AgentDrizzleDb): Promise<void> {
  const dialect = agentDialectOf(db);
  if (dialect === 'postgres') {
    await (db as AgentPgDb).transaction(async (tx) => {
      await tx.execute(sql.raw(`select pg_advisory_xact_lock(hashtext('${LOCK_NAME}'))`));
      await heal(tx as unknown as AgentDrizzleDb, dialect);
    });
    return;
  }
  if (dialect === 'mysql') {
    await (db as AgentMySqlDb).transaction(async (tx) => {
      // A session lock: taken and released on the transaction's one connection. MySQL's DDL commits
      // implicitly, so this is a pinned connection rather than an atomic heal.
      await tx.execute(sql.raw(`select get_lock('${LOCK_NAME}', 30)`));
      try {
        await heal(tx as unknown as AgentDrizzleDb, dialect);
      } finally {
        await tx.execute(sql.raw(`select release_lock('${LOCK_NAME}')`));
      }
    });
    return;
  }
  await heal(db, dialect);
}

const LOCK_NAME = 'nestjs_agent_schema';

/** Table options MySQL needs spelled out: InnoDB for the foreign keys, a case-sensitive collation. */
const MYSQL_TABLE_OPTIONS = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin';

interface IndexSpec {
  name: string;
  unique: boolean;
  columns: string[];
}

interface TableSpec {
  name: string;
  columns: Column[];
  primaryKey: string[];
  foreignKeys: { columns: string[]; table: string; foreignColumns: string[]; onDelete?: string }[];
  indexes: IndexSpec[];
}

/** One agent table, read off its Drizzle definition in `dialect`. */
function tableSpec(dialect: AgentDialect, table: unknown): TableSpec {
  const config =
    dialect === 'postgres'
      ? pgTableConfig(table as Parameters<typeof pgTableConfig>[0])
      : dialect === 'mysql'
        ? mysqlTableConfig(table as Parameters<typeof mysqlTableConfig>[0])
        : sqliteTableConfig(table as Parameters<typeof sqliteTableConfig>[0]);
  const columns = config.columns as unknown as Column[];
  const compositeKey = config.primaryKeys[0]?.columns.map((column) => column.name);
  return {
    name: config.name,
    columns,
    primaryKey: compositeKey ?? columns.filter((column) => column.primary).map((c) => c.name),
    foreignKeys: config.foreignKeys.map((foreignKey) => {
      const reference = foreignKey.reference();
      return {
        columns: reference.columns.map((column) => column.name),
        table: getTableName(reference.foreignTable),
        foreignColumns: reference.foreignColumns.map((column) => column.name),
        ...(foreignKey.onDelete !== undefined ? { onDelete: foreignKey.onDelete } : {}),
      };
    }),
    indexes: config.indexes.map((index) => ({
      name: String(index.config.name),
      unique: index.config.unique === true,
      columns: (index.config.columns as { name?: string }[]).map((column) => String(column.name)),
    })),
  };
}

function quote(dialect: AgentDialect, identifier: string): string {
  return dialect === 'mysql' ? `\`${identifier}\`` : `"${identifier}"`;
}

function literal(dialect: AgentDialect, value: unknown): string {
  if (typeof value === 'boolean') {
    return dialect === 'sqlite' ? (value ? '1' : '0') : value ? 'true' : 'false';
  }
  if (typeof value === 'number') return String(value);
  return `'${String(value).replaceAll("'", "''")}'`;
}

/** `name TYPE [NOT NULL] [DEFAULT …]` — no key or reference, which the table states separately. */
function columnDefinition(dialect: AgentDialect, column: Column): string {
  const parts = [quote(dialect, column.name), column.getSQLType()];
  if (column.notNull) parts.push('NOT NULL');
  if (column.hasDefault && column.default !== undefined) {
    parts.push(`DEFAULT ${literal(dialect, column.default)}`);
  }
  return parts.join(' ');
}

function createTableSql(dialect: AgentDialect, spec: TableSpec): string {
  const q = (identifier: string) => quote(dialect, identifier);
  const lines = spec.columns.map((column) => columnDefinition(dialect, column));
  lines.push(`PRIMARY KEY (${spec.primaryKey.map(q).join(', ')})`);
  for (const foreignKey of spec.foreignKeys) {
    lines.push(
      `FOREIGN KEY (${foreignKey.columns.map(q).join(', ')}) REFERENCES ${q(foreignKey.table)} (${foreignKey.foreignColumns.map(q).join(', ')})${foreignKey.onDelete !== undefined ? ` ON DELETE ${foreignKey.onDelete.toUpperCase()}` : ''}`,
    );
  }
  const options = dialect === 'mysql' ? ` ${MYSQL_TABLE_OPTIONS}` : '';
  return `CREATE TABLE IF NOT EXISTS ${q(spec.name)} (\n  ${lines.join(',\n  ')}\n)${options}`;
}

/** The DDL that creates the agent tables in `dialect`, in dependency order. Indexes included. */
export function agentSchemaDdl(dialect: AgentDialect): string[] {
  const statements: string[] = [];
  for (const spec of specs(dialect)) {
    statements.push(createTableSql(dialect, spec));
    for (const index of spec.indexes) {
      statements.push(createIndexSql(dialect, spec.name, index));
    }
  }
  return statements;
}

function createIndexSql(dialect: AgentDialect, table: string, index: IndexSpec): string {
  const q = (identifier: string) => quote(dialect, identifier);
  // MySQL has no `IF NOT EXISTS` on an index; `heal` asks first there.
  const guard = dialect === 'mysql' ? '' : 'IF NOT EXISTS ';
  return `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX ${guard}${q(index.name)} ON ${q(table)} (${index.columns.map(q).join(', ')})`;
}

/** Every agent table in `dialect`, parents before the children that reference them. */
function specs(dialect: AgentDialect): TableSpec[] {
  const all = Object.values(agentTablesFor(dialect)).map((table) => tableSpec(dialect, table));
  const ordered: TableSpec[] = [];
  const placed = new Set<string>();
  while (ordered.length < all.length) {
    const ready = all.filter(
      (spec) =>
        !placed.has(spec.name) &&
        spec.foreignKeys.every((key) => key.table === spec.name || placed.has(key.table)),
    );
    if (ready.length === 0) throw new Error('agent schema: circular foreign keys');
    for (const spec of ready) {
      ordered.push(spec);
      placed.add(spec.name);
    }
  }
  return ordered;
}

async function existingColumns(
  db: AgentDrizzleDb,
  dialect: AgentDialect,
  table: string,
): Promise<Set<string>> {
  const rows =
    dialect === 'sqlite'
      ? await querySql<{ name: string }>(db, dialect, sql.raw(`PRAGMA table_info("${table}")`))
      : await querySql<{ name: string }>(
          db,
          dialect,
          sql`select column_name as name from information_schema.columns where table_schema = ${sql.raw(dialect === 'mysql' ? 'database()' : 'current_schema()')} and table_name = ${table}`,
        );
  return new Set(rows.map((row) => String(row.name)));
}

async function indexExists(
  db: AgentDrizzleDb,
  dialect: AgentDialect,
  table: string,
  index: string,
): Promise<boolean> {
  let query: SQL;
  if (dialect === 'sqlite') {
    query = sql`select name from sqlite_master where type = 'index' and name = ${index}`;
  } else if (dialect === 'postgres') {
    query = sql`select indexname as name from pg_indexes where schemaname = current_schema() and indexname = ${index}`;
  } else {
    query = sql`select index_name as name from information_schema.statistics where table_schema = database() and table_name = ${table} and index_name = ${index}`;
  }
  return (await querySql(db, dialect, query)).length > 0;
}

async function heal(db: AgentDrizzleDb, dialect: AgentDialect): Promise<void> {
  for (const spec of specs(dialect)) {
    await runSql(db, dialect, sql.raw(createTableSql(dialect, spec)));
    // `CREATE TABLE IF NOT EXISTS` is inert against a table that is already there, so a column the
    // schema gained since is added here. Asked, not attempted-and-swallowed: a swallowed error cannot
    // tell "already there" from "the ALTER is malformed".
    const present = await existingColumns(db, dialect, spec.name);
    for (const column of spec.columns) {
      if (!present.has(column.name)) {
        await runSql(
          db,
          dialect,
          sql.raw(
            `ALTER TABLE ${quote(dialect, spec.name)} ADD COLUMN ${columnDefinition(dialect, column)}`,
          ),
        );
      }
    }
    for (const index of spec.indexes) {
      if (!(await indexExists(db, dialect, spec.name, index.name))) {
        await runSql(db, dialect, sql.raw(createIndexSql(dialect, spec.name, index)));
      }
    }
  }
}
