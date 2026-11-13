import { type Column, type SQL, getTableName, sql } from 'drizzle-orm';
import { getTableConfig as mysqlTableConfig } from 'drizzle-orm/mysql-core';
import { getTableConfig as pgTableConfig } from 'drizzle-orm/pg-core';
import { getTableConfig as sqliteTableConfig } from 'drizzle-orm/sqlite-core';
import {
  type AgentDialect,
  type AgentDrizzleDb,
  type AgentMySqlDb,
  type AgentPgDb,
  type AgentSchemaOptions,
  agentDialectOf,
  agentTablesFor,
  assertAgentSchema,
  querySql,
  runSql,
} from './dialect.js';

/**
 * Creates the agent tables a database lacks, adds the columns and indexes an existing one lacks, and
 * relaxes a column the schema made nullable since (`agent_token_usage.thread_id`: usage recorded
 * outside a conversation) — never drops anything — safe to run on every boot against a shared
 * database. Postgres drops the `NOT NULL` in place, MySQL `MODIFY`s the column, and SQLite, which can
 * do neither, rebuilds that one table (created under a scratch name, rows copied, renamed) inside a
 * savepoint; only a table no other table references is rebuilt, and its indexes come back below. SQLite,
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
export async function ensureAgentSchema(
  db: AgentDrizzleDb,
  options: AgentSchemaOptions = {},
): Promise<void> {
  const dialect = agentDialectOf(db);
  const schema = options.schema;
  assertAgentSchema(dialect, schema);
  // The lock names the schema, so two installs in two schemas of one database heal independently.
  const lock = schema === undefined ? LOCK_NAME : `${LOCK_NAME}:${schema}`;
  if (dialect === 'postgres') {
    await (db as AgentPgDb).transaction(async (tx) => {
      await tx.execute(sql.raw(`select pg_advisory_xact_lock(hashtext('${lock}'))`));
      if (schema !== undefined)
        await createSchema(tx as unknown as AgentDrizzleDb, dialect, schema);
      await heal(tx as unknown as AgentDrizzleDb, dialect, schema);
    });
    return;
  }
  if (dialect === 'mysql') {
    await (db as AgentMySqlDb).transaction(async (tx) => {
      // A session lock: taken and released on the transaction's one connection. MySQL's DDL commits
      // implicitly, so this is a pinned connection rather than an atomic heal.
      await tx.execute(sql.raw(`select get_lock('${lock}', 30)`));
      try {
        if (schema !== undefined) {
          await createSchema(tx as unknown as AgentDrizzleDb, dialect, schema);
        }
        await heal(tx as unknown as AgentDrizzleDb, dialect, schema);
      } finally {
        await tx.execute(sql.raw(`select release_lock('${lock}')`));
      }
    });
    return;
  }
  await heal(db, dialect, undefined);
}

const LOCK_NAME = 'nestjs_agent_schema';

/**
 * `CREATE SCHEMA IF NOT EXISTS` (Postgres) or `CREATE DATABASE IF NOT EXISTS` (MySQL). A role that may
 * not create it fails with the grant it needs.
 */
async function createSchema(
  db: AgentDrizzleDb,
  dialect: AgentDialect,
  schema: string,
): Promise<void> {
  const statement =
    dialect === 'mysql'
      ? `CREATE DATABASE IF NOT EXISTS ${quote(dialect, schema)}`
      : `CREATE SCHEMA IF NOT EXISTS ${quote(dialect, schema)}`;
  try {
    await runSql(db, dialect, sql.raw(statement));
  } catch (error) {
    const grant =
      dialect === 'mysql'
        ? `GRANT CREATE ON \`${schema}\`.* TO <user>, or create the database yourself`
        : 'GRANT CREATE ON DATABASE <db> TO <role>, or create the schema yourself';
    throw new Error(
      `nestjs-agent store: could not create the ${dialect === 'mysql' ? 'database' : 'schema'} "${schema}" (${error instanceof Error ? error.message : String(error)}). ${grant}.`,
    );
  }
}

/** `table` in `schema` when set (`"schema"."table"`), else just quoted. */
function tableRef(dialect: AgentDialect, table: string, schema: string | undefined): string {
  return schema === undefined
    ? quote(dialect, table)
    : `${quote(dialect, schema)}.${quote(dialect, table)}`;
}

/** The catalog's filter for the schema: the configured name, else the connection's current one. */
function schemaFilter(dialect: AgentDialect, schema: string | undefined): SQL {
  if (schema !== undefined) return sql`${schema}`;
  return sql.raw(dialect === 'mysql' ? 'database()' : 'current_schema()');
}

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

function createTableSql(dialect: AgentDialect, spec: TableSpec, schema?: string): string {
  const q = (identifier: string) => quote(dialect, identifier);
  const t = (table: string) => tableRef(dialect, table, schema);
  const lines = spec.columns.map((column) => columnDefinition(dialect, column));
  lines.push(`PRIMARY KEY (${spec.primaryKey.map(q).join(', ')})`);
  for (const foreignKey of spec.foreignKeys) {
    lines.push(
      `FOREIGN KEY (${foreignKey.columns.map(q).join(', ')}) REFERENCES ${t(foreignKey.table)} (${foreignKey.foreignColumns.map(q).join(', ')})${foreignKey.onDelete !== undefined ? ` ON DELETE ${foreignKey.onDelete.toUpperCase()}` : ''}`,
    );
  }
  const options = dialect === 'mysql' ? ` ${MYSQL_TABLE_OPTIONS}` : '';
  return `CREATE TABLE IF NOT EXISTS ${t(spec.name)} (\n  ${lines.join(',\n  ')}\n)${options}`;
}

/**
 * The DDL that creates the agent tables in `dialect`, in dependency order. Indexes included. With
 * `schema`, every table is qualified with it, preceded by its `CREATE SCHEMA` / `CREATE DATABASE`.
 */
export function agentSchemaDdl(dialect: AgentDialect, options: AgentSchemaOptions = {}): string[] {
  const schema = options.schema;
  assertAgentSchema(dialect, schema);
  const statements: string[] =
    schema === undefined
      ? []
      : [
          dialect === 'mysql'
            ? `CREATE DATABASE IF NOT EXISTS ${quote(dialect, schema)}`
            : `CREATE SCHEMA IF NOT EXISTS ${quote(dialect, schema)}`,
        ];
  for (const spec of specs(dialect, schema)) {
    statements.push(createTableSql(dialect, spec, schema));
    for (const index of spec.indexes) {
      statements.push(createIndexSql(dialect, spec.name, index, schema));
    }
  }
  return statements;
}

function createIndexSql(
  dialect: AgentDialect,
  table: string,
  index: IndexSpec,
  schema?: string,
): string {
  const q = (identifier: string) => quote(dialect, identifier);
  // MySQL has no `IF NOT EXISTS` on an index; `heal` asks first there.
  const guard = dialect === 'mysql' ? '' : 'IF NOT EXISTS ';
  return `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX ${guard}${q(index.name)} ON ${tableRef(dialect, table, schema)} (${index.columns.map(q).join(', ')})`;
}

/** Every agent table in `dialect`, parents before the children that reference them. */
function specs(dialect: AgentDialect, schema?: string): TableSpec[] {
  const all = Object.values(agentTablesFor(dialect, schema)).map((table) =>
    tableSpec(dialect, table),
  );
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
  schema: string | undefined,
): Promise<Set<string>> {
  return new Set((await columnNullability(db, dialect, table, schema)).keys());
}

/** Each column the table has, and whether the database lets it hold NULL. */
async function columnNullability(
  db: AgentDrizzleDb,
  dialect: AgentDialect,
  table: string,
  schema: string | undefined,
): Promise<Map<string, boolean>> {
  if (dialect === 'sqlite') {
    const rows = await querySql<{ name: string; notnull: number }>(
      db,
      dialect,
      sql.raw(`PRAGMA table_info("${table}")`),
    );
    return new Map(rows.map((row) => [String(row.name), Number(row.notnull) === 0]));
  }
  const rows = await querySql<{ name: string; nullable: string }>(
    db,
    dialect,
    sql`select column_name as name, is_nullable as nullable from information_schema.columns where table_schema = ${schemaFilter(dialect, schema)} and table_name = ${table}`,
  );
  return new Map(
    rows.map((row) => [
      String(row.name ?? (row as { NAME?: string }).NAME),
      String(row.nullable ?? (row as { NULLABLE?: string }).NULLABLE).toUpperCase() === 'YES',
    ]),
  );
}

/**
 * Let `column` hold NULL. In place on Postgres and MySQL; on SQLite the table is rebuilt in its
 * current shape under a scratch name, its rows copied, and renamed over the old one, inside a
 * savepoint — refused for a table another agent table references, whose foreign keys a rebuild
 * would break.
 */
async function relaxNotNull(
  db: AgentDrizzleDb,
  dialect: AgentDialect,
  spec: TableSpec,
  column: Column,
  all: readonly TableSpec[],
  schema: string | undefined,
): Promise<void> {
  const q = (identifier: string) => quote(dialect, identifier);
  if (dialect === 'postgres') {
    await runSql(
      db,
      dialect,
      sql.raw(
        `ALTER TABLE ${tableRef(dialect, spec.name, schema)} ALTER COLUMN ${q(column.name)} DROP NOT NULL`,
      ),
    );
    return;
  }
  if (dialect === 'mysql') {
    await runSql(
      db,
      dialect,
      sql.raw(
        `ALTER TABLE ${tableRef(dialect, spec.name, schema)} MODIFY ${columnDefinition(dialect, column)}`,
      ),
    );
    return;
  }
  if (
    all.some((other) => other.foreignKeys.some((key) => key.table === spec.name && other !== spec))
  ) {
    throw new Error(
      `agent schema: cannot make ${spec.name}.${column.name} nullable on SQLite — other tables reference ${spec.name}`,
    );
  }
  const scratch = `${spec.name}__rebuild`;
  const present = [...(await columnNullability(db, dialect, spec.name, undefined)).keys()];
  const list = present.map(q).join(', ');
  await runSql(db, dialect, sql.raw('SAVEPOINT agent_schema_rebuild'));
  try {
    await runSql(db, dialect, sql.raw(`DROP TABLE IF EXISTS ${q(scratch)}`));
    await runSql(db, dialect, sql.raw(createTableSql(dialect, { ...spec, name: scratch })));
    await runSql(
      db,
      dialect,
      sql.raw(`INSERT INTO ${q(scratch)} (${list}) SELECT ${list} FROM ${q(spec.name)}`),
    );
    await runSql(db, dialect, sql.raw(`DROP TABLE ${q(spec.name)}`));
    await runSql(db, dialect, sql.raw(`ALTER TABLE ${q(scratch)} RENAME TO ${q(spec.name)}`));
    await runSql(db, dialect, sql.raw('RELEASE SAVEPOINT agent_schema_rebuild'));
  } catch (error) {
    await runSql(db, dialect, sql.raw('ROLLBACK TO SAVEPOINT agent_schema_rebuild')).catch(
      () => undefined,
    );
    await runSql(db, dialect, sql.raw('RELEASE SAVEPOINT agent_schema_rebuild')).catch(
      () => undefined,
    );
    throw error;
  }
}

async function indexExists(
  db: AgentDrizzleDb,
  dialect: AgentDialect,
  table: string,
  index: string,
  schema: string | undefined,
): Promise<boolean> {
  let query: SQL;
  if (dialect === 'sqlite') {
    query = sql`select name from sqlite_master where type = 'index' and name = ${index}`;
  } else if (dialect === 'postgres') {
    query = sql`select indexname as name from pg_indexes where schemaname = ${schemaFilter(dialect, schema)} and indexname = ${index}`;
  } else {
    query = sql`select index_name as name from information_schema.statistics where table_schema = ${schemaFilter(dialect, schema)} and table_name = ${table} and index_name = ${index}`;
  }
  return (await querySql(db, dialect, query)).length > 0;
}

async function heal(
  db: AgentDrizzleDb,
  dialect: AgentDialect,
  schema: string | undefined,
): Promise<void> {
  const all = specs(dialect, schema);
  for (const spec of all) {
    await runSql(db, dialect, sql.raw(createTableSql(dialect, spec, schema)));
    // `CREATE TABLE IF NOT EXISTS` is inert against a table that is already there, so a column the
    // schema gained since is added here. Asked, not attempted-and-swallowed: a swallowed error cannot
    // tell "already there" from "the ALTER is malformed".
    const present = await existingColumns(db, dialect, spec.name, schema);
    for (const column of spec.columns) {
      if (!present.has(column.name)) {
        await runSql(
          db,
          dialect,
          sql.raw(
            `ALTER TABLE ${tableRef(dialect, spec.name, schema)} ADD COLUMN ${columnDefinition(dialect, column)}`,
          ),
        );
      }
    }
    // A column the schema made nullable since it was created. Primary-key columns are left alone:
    // drizzle reports them nullable on some dialects, and none of them ever relaxes.
    const nullable = await columnNullability(db, dialect, spec.name, schema);
    for (const column of spec.columns) {
      if (column.notNull || spec.primaryKey.includes(column.name)) continue;
      if (nullable.get(column.name) === false) {
        await relaxNotNull(db, dialect, spec, column, all, schema);
      }
    }
    for (const index of spec.indexes) {
      if (!(await indexExists(db, dialect, spec.name, index.name, schema))) {
        await runSql(db, dialect, sql.raw(createIndexSql(dialect, spec.name, index, schema)));
      }
    }
  }
}
