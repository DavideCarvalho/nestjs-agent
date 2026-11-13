import { createHash } from 'node:crypto';
import type { Connection, EntityManager, EntityMetadata, MikroORM } from '@mikro-orm/core';
import { declaredCollations, reconcileMySqlCollations } from './mysql-collations';
import { type AgentSchemaOptions, assertAgentSchema, tableIn } from './schema-name';

/**
 * The tables this store owns. The schema heal and fingerprint are scoped to exactly these, so
 * `ensureAgentSchema` never touches (or diffs) the host app's own tables on a shared database.
 */
const AGENT_TABLE_NAMES = new Set([
  'agent_action_proposal',
  'agent_thread',
  'agent_message',
  'agent_queued_message',
  'agent_tool_call',
  'agent_token_usage',
  'agent_genui_call',
  'agent_model_pricing',
  'agent_run',
  'agent_memory',
  'rag_ingestion_log',
  'agent_stream_frame',
  'agent_confirm_token',
  'agent_channel_state',
  'agent_poppy_conversation',
  'agent_poppy_event',
  'agent_poppy_message',
  'agent_poppy_connection',
  'agent_poppy_connect',
]);

/**
 * Tables this store creates and manages at boot (autoSchema). Feed to your ORM's migration differ
 * skip/exclude list so it never tries to drop them.
 *
 * ```ts
 * await MikroORM.init({
 *   // ...your entities/driver config
 *   schemaGenerator: { skipTables: agentManagedTables() },
 * });
 * ```
 *
 * Derived from the SAME {@link AGENT_TABLE_NAMES} set {@link ensureAgentSchema} scopes its own heal
 * to — mirrors `durableManagedTables()` / `telescopeManagedTables()` in the sibling
 * `@dudousxd/nestjs-durable` / `-telescope` ecosystem, so a consumer's denylist can never hand-drift
 * from what this store actually owns. Does NOT include `agent_schema_meta` (the boot fingerprint
 * marker table) — same convention as `durableManagedTables()`.
 */
export function agentManagedTables(): string[] {
  return [...AGENT_TABLE_NAMES];
}

/** A tiny marker table holding one row: the fingerprint of the agent schema last applied. */
const MARKER_TABLE = 'agent_schema_meta';
const MARKER_ROW_ID = 'agent';
const SCHEMA_LOCK_NAME = 'agent_schema';
/**
 * Bump to force a re-heal on the next boot even when the entity metadata is unchanged.
 * 2: MySQL columns are reconciled to their declared collation (earlier heals left them in the table
 * default), so a database healed before it gets the correction once.
 * 3: `agent_genui_call` (generative-UI telemetry).
 * 4: `agent_run.ttft_ms` / `cost_usd` / `model_id` (run metrics).
 * 5: the usage ledger beyond agent turns (`agent_token_usage.thread_id` nullable, `feature`, the
 * units, `metadata`) and the run timings (`agent_run.queue_ms`, `model_ms`, `tools_ms`, …).
 * 6: `agent_token_usage.counts_towards_quota`.
 * 7: the `agent_token_usage (tenant_ref, created_at)` index (`quota.per: 'tenant'`).
 */
const SCHEMA_REVISION = 7;

/**
 * Non-destructive, fingerprint-gated schema management for the agent tables — the "autoSchema" the
 * host gets for free at boot, matching how `@dudousxd/nestjs-durable` and `-notifications` manage
 * their own tables on a shared MikroORM.
 *
 * Steady-state boots are a single cheap read: the fingerprint of the agent entity metadata is
 * compared to the one stored in {@link MARKER_TABLE}, and when they match this returns immediately —
 * no introspection, so it never deadlocks or slows a shared multi-owner boot. Only when the
 * fingerprint changes (first boot, or the lib evolved its schema) does it introspect and apply the
 * additive diff, under an advisory lock so concurrent replicas don't race.
 *
 * The heal runs `getUpdateSchemaSQL({ safe: true })` on a **fresh** schema generator built straight
 * from the platform — so it ignores any `schemaGenerator.skipTables` the host set (hosts skip
 * `agent_` in their own snapshot precisely because this owns those tables) — and applies only the
 * statements whose every table is an agent table, including the multi-statement table rebuild SQLite
 * uses in place of `add column`. It creates and adds only: `safe` keeps columns and tables, and the
 * index, key and column drops the diff still emits are filtered out, so an older release never drops
 * an index a newer one added, and no release drops one the host added. The one alteration it makes is on MySQL: a string column whose collation differs from the
 * one its entity declares (MikroORM before 7.2 created every column in the table default) is
 * corrected — after checking no row would collide or lose its parent under the declared collation,
 * and refusing with {@link AgentSchemaCollationError} when one would (see `mysql-collations.ts`).
 *
 * What the heal applied is then re-diffed, and a heal that left required structure pending throws
 * {@link AgentSchemaHealError} — the fingerprint is written only on the way out, so a boot that
 * healed nothing cannot record itself as the applied schema and silence every boot after it.
 */
export async function ensureAgentSchema(
  orm: MikroORM,
  options: AgentSchemaOptions = {},
): Promise<void> {
  const em = orm.em;
  const connection = em.getConnection();
  const dialect = detectDialect(em);
  const schema = options.schema;
  assertAgentSchema(em, schema);
  const marker = new Marker(em, schema);

  if (schema !== undefined) await createSchema(em, dialect, schema);
  await createMarkerTable(em, dialect, marker);
  const expected = computeExpectedFingerprint(orm);
  if ((await marker.read(connection)) === expected) {
    return;
  }

  await withSchemaLock(em, dialect, schema, async () => {
    // Re-read under the lock: another replica may have healed while we waited.
    if ((await marker.read(connection)) === expected) {
      return;
    }
    await healAgentSchema(em, dialect, schema);
    await marker.write(connection, dialect, expected);
  });
}

/**
 * `create schema if not exists` (Postgres) or `create database if not exists` (MySQL). A role that may
 * not create it fails with the grant it needs.
 */
async function createSchema(em: EntityManager, dialect: SqlDialect, schema: string): Promise<void> {
  const statement =
    dialect === 'mysql'
      ? `create database if not exists \`${schema}\``
      : `create schema if not exists "${schema}"`;
  try {
    await em.getConnection().execute(statement);
  } catch (error) {
    const grant =
      dialect === 'mysql'
        ? `GRANT CREATE ON \`${schema}\`.* TO <user>, or create the database yourself`
        : 'GRANT CREATE ON DATABASE <db> TO <role>, or create the schema yourself';
    throw new Error(
      `[nestjs-agent-store-mikro-orm] could not create the ${dialect === 'mysql' ? 'database' : 'schema'} "${schema}" (${error instanceof Error ? error.message : String(error)}). ${grant}.`,
    );
  }
}

/**
 * The heal ran and the structure it was asked for is still missing. The fingerprint is written only
 * after the heal returns, so throwing this is what keeps a boot that healed nothing from recording
 * itself as the applied schema — the next boot introspects again instead of returning early forever.
 */
export class AgentSchemaHealError extends Error {
  constructor(readonly pending: string[]) {
    super(
      `[nestjs-agent-store-mikro-orm] the agent schema heal did not apply: ${pending.length} statement(s) the schema diff asked for are still pending after it ran. The schema fingerprint was NOT recorded, so the next boot retries. Apply them by hand (or via \`agentSchemaSql()\` in a migration) if the database rejects them: ${pending.join('; ')}`,
    );
    this.name = 'AgentSchemaHealError';
  }
}

async function healAgentSchema(
  em: EntityManager,
  dialect: SqlDialect,
  schema: string | undefined,
): Promise<void> {
  const connection = em.getConnection();
  const collations =
    dialect === 'mysql' ? declaredCollations(agentMetadata(em)) : new Map<string, string>();
  // Existing columns first, so the diff below no longer asks for the bare `modify` MySQL refuses on
  // a key a foreign key points at; then again for whatever the diff just created without its collation.
  await reconcileMySqlCollations(em, collations, schema);
  const statements = await agentUpdateStatements(em, schema);
  if (statements.length === 0) {
    // Nothing to apply — but a nullability change the safe diff does not emit still has to have
    // landed before this revision is recorded.
    const unrelaxed = await unrelaxedColumns(em, dialect, schema);
    if (unrelaxed.length > 0) throw new AgentSchemaHealError(unrelaxed);
    return;
  }
  await withoutForeignKeyEnforcement(connection, dialect, async () => {
    for (const statement of statements) {
      try {
        await connection.execute(statement);
      } catch (error) {
        // A create/add statement failing is fatal — the store can't run without its tables. A
        // non-structural tweak (a column-type nudge) a shared DB rejects is left as-is, functional.
        if (isRequiredStructure(statement)) {
          throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        console.warn(
          `[nestjs-agent-store-mikro-orm] skipped a non-structural agent-schema statement that failed; the column is left as-is (functional). Statement: ${statement} — ${message}`,
        );
      }
    }
  });
  // Ask the differ again rather than trust that every statement returning without an error means the
  // schema moved: a filtered, rewritten or silently-swallowed statement leaves no error to catch.
  await reconcileMySqlCollations(em, collations, schema);
  const pending = (await agentUpdateStatements(em, schema)).filter(isRequiredStructure);
  // A nullability change is not "required structure" to the filter above (it is an alter), yet usage
  // recorded outside a conversation fails on every write without it — so it is checked by itself,
  // and an unrelaxed column keeps the fingerprint from being written.
  pending.push(...(await unrelaxedColumns(em, dialect, schema)));
  if (pending.length > 0) {
    throw new AgentSchemaHealError(pending);
  }
}

/** Columns created NOT NULL by an earlier release and nullable now, which the heal must relax. */
const RELAXED_COLUMNS: readonly { table: string; column: string }[] = [
  { table: 'agent_token_usage', column: 'thread_id' },
];

/** Each {@link RELAXED_COLUMNS} entry the database still holds NOT NULL, as a pending statement. */
async function unrelaxedColumns(
  em: EntityManager,
  dialect: SqlDialect,
  schema: string | undefined,
): Promise<string[]> {
  const pending: string[] = [];
  for (const { table, column } of RELAXED_COLUMNS) {
    if (!(await columnIsNullable(em, dialect, table, column, schema))) {
      pending.push(`${table}.${column} must accept NULL`);
    }
  }
  return pending;
}

/** Whether `table.column` accepts NULL, from the catalog; `true` when the dialect cannot say. */
async function columnIsNullable(
  em: EntityManager,
  dialect: SqlDialect,
  table: string,
  column: string,
  schema: string | undefined,
): Promise<boolean> {
  const connection = em.getConnection();
  if (dialect === 'sqlite') {
    const rows = (await connection.execute(`pragma table_info(${table})`)) as {
      name: string;
      notnull: number;
    }[];
    const row = rows.find((each) => each.name === column);
    return row === undefined || Number(row.notnull) === 0;
  }
  if (dialect !== 'mysql' && dialect !== 'postgres') return true;
  // A configured schema is a validated identifier, so it is safe as a literal.
  const current =
    schema !== undefined ? `'${schema}'` : dialect === 'mysql' ? 'database()' : 'current_schema()';
  const rows = (await connection.execute(
    `select is_nullable as nullable from information_schema.columns where table_schema = ${current} and table_name = ? and column_name = ?`,
    [table, column],
  )) as { nullable?: string; NULLABLE?: string }[];
  const value = rows[0]?.nullable ?? rows[0]?.NULLABLE;
  return value === undefined || String(value).toUpperCase() === 'YES';
}

/** The metadata of the tables this store owns, as the host registered them. */
function agentMetadata(em: EntityManager): EntityMetadata[] {
  return [...em.getMetadata().getAll().values()].filter((meta) =>
    AGENT_TABLE_NAMES.has(meta.tableName),
  );
}

/**
 * Run the heal with SQLite's foreign-key enforcement off, restoring it afterwards.
 *
 * SQLite implements `add column` as a table REBUILD — the original is DROPped and a rewritten twin
 * renamed into its place. With enforcement on, dropping `agent_thread` fires the children's
 * `on delete cascade`, so healing the thread table would take every message, tool call and usage row
 * with it. The pragma is a no-op inside a transaction, so the heal deliberately runs outside one.
 */
async function withoutForeignKeyEnforcement(
  connection: Connection,
  dialect: SqlDialect,
  apply: () => Promise<void>,
): Promise<void> {
  if (dialect !== 'sqlite') {
    await apply();
    return;
  }
  const rows = await connection.execute<{ foreign_keys: number }[]>('pragma foreign_keys');
  // Anything but a positive "off" restores enforcement: leaving it off afterwards is the worse
  // mistake, since every later write on the connection would skip its foreign keys too.
  const wasEnforcing = rows[0]?.foreign_keys !== 0;
  await connection.execute('pragma foreign_keys = off');
  try {
    await apply();
  } finally {
    if (wasEnforcing) {
      await connection.execute('pragma foreign_keys = on');
    }
  }
}

/** Additive update DDL for the agent tables, in the host's dialect, ignoring the host's skipTables. */
async function agentUpdateStatements(
  em: EntityManager,
  schema: string | undefined,
): Promise<string[]> {
  // A generator built from the platform (not `orm.schema`) carries no `schemaGenerator.skipTables`,
  // so it sees the agent tables even when the host excludes `agent_` from its own snapshot diff.
  // With a schema, the generator is built from the driver view alone: given the EntityManager, it
  // reads the host's own driver (and config) off it instead.
  const generator =
    schema === undefined
      ? em.getPlatform().getSchemaGenerator(em.getDriver(), em)
      : em.getPlatform().getSchemaGenerator(driverIn(em, schema));
  const sql = await generator.getUpdateSchemaSQL({
    safe: true,
    wrap: false,
    ...(schema !== undefined ? { schema } : {}),
  });
  return sql
    .split(';')
    .map((statement) => statement.trim())
    .filter(
      (statement) => statement.length > 0 && belongsToAgent(statement) && !isDestructive(statement),
    );
}

/**
 * The host's driver as the schema generator sees it, with `schema` as the configured default.
 *
 * MikroORM's generator places an entity without a schema of its own in `config.schema`, whatever
 * schema the diff is asked for, so the agent tables would be diffed (and created) in the
 * connection's default schema. This view answers `schema` for that one setting and leaves the host's
 * configuration untouched: nothing else, and no other query, ever sees it.
 */
function driverIn(
  em: EntityManager,
  schema: string | undefined,
): ReturnType<EntityManager['getDriver']> {
  const driver = em.getDriver();
  if (schema === undefined) return driver;
  const config = new Proxy(driver.config, {
    get(target, property) {
      if (property === 'get') {
        return (key: string, fallback?: unknown) =>
          key === 'schema'
            ? schema
            : (target.get as (k: string, d?: unknown) => unknown)(key, fallback);
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const connection =
    detectDialect(em) === 'mysql' ? catalogIn(driver.getConnection(), schema) : undefined;
  return new Proxy(driver, {
    get(target, property) {
      if (property === 'config') return config;
      if (property === 'getConnection' && connection !== undefined) return () => connection;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** The catalog filters MikroORM's MySQL introspection pins to the connection's current database. */
const MYSQL_CATALOG_FILTER =
  /\b(table_schema|constraint_schema|routine_schema|specific_schema|event_object_schema)\s*=\s*(?:database|schema)\(\)/gi;

/**
 * MikroORM introspects MySQL only in the connection's current database (`table_schema = database()`),
 * so with a `schema` it would never see the agent tables. This connection view rewrites those
 * catalog filters, in the introspection reads alone, to the configured database. Nothing switches
 * the session's database (`USE`), which would leak to whoever gets the pooled connection next.
 */
function catalogIn(connection: Connection, schema: string): Connection {
  return new Proxy(connection, {
    get(target, property) {
      if (property === 'execute') {
        return (query: unknown, ...rest: unknown[]) => {
          const rewritten =
            typeof query === 'string' && /information_schema/i.test(query)
              ? query
                  .replace(
                    MYSQL_CATALOG_FILTER,
                    (_match, column: string) => `${column} = '${schema}'`,
                  )
                  // Its foreign-key read never selects the referenced table's database, so a key
                  // into `schema` would always read as one into the current database.
                  .replace(
                    'k.referenced_table_name as referenced_table_name,',
                    'k.referenced_table_name as referenced_table_name, nullif(k.referenced_table_schema, schema()) as referenced_schema_name,',
                  )
              : query;
          return (target.execute as (...args: unknown[]) => unknown).call(
            target,
            rewritten,
            ...rest,
          );
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * A statement that removes structure from a live table. `safe: true` keeps columns and tables, yet
 * still drops every index and foreign key the entities no longer declare. A store one release behind
 * (a rollback, an old replica in a rolling deploy) would drop an index the newer release added, and
 * any store would drop an index or key the host app added to an agent table. The heal only creates
 * and adds, so these never run. The SQLite rebuild's `drop table` is not one: it drops the old copy
 * after the rows moved into the new one.
 */
function isDestructive(statement: string): boolean {
  return /\bdrop\s+(?:index|key|foreign\s+key|constraint|column|primary\s+key|unique)\b/i.test(
    statement,
  );
}

/**
 * A statement the store may run: every table it names is one this store owns.
 *
 * "Names" is the whole statement, not just its target, because a SQLite rebuild moves rows between
 * two tables (`insert into agent_thread__temp_alter … from agent_thread`) and a heal that ran half
 * of one is worse than one that ran none of it. Requiring ALL of them is also what keeps the
 * rebuild's `drop table` from ever pointing at a table the host owns.
 */
function belongsToAgent(statement: string): boolean {
  const tables = namedTables(statement);
  return tables.length > 0 && tables.every(isAgentTable);
}

/**
 * MikroORM's scratch table for a SQLite rebuild: `agent_thread` is rewritten as
 * `agent_thread__temp_alter` and renamed back over it.
 */
const REBUILD_TABLE_SUFFIX = '__temp_alter';

function isAgentTable(table: string): boolean {
  return AGENT_TABLE_NAMES.has(
    table.endsWith(REBUILD_TABLE_SUFFIX) ? table.slice(0, -REBUILD_TABLE_SUFFIX.length) : table,
  );
}

/** Every table a DDL or rebuild statement names, lowercased. Empty for anything else (`pragma`). */
function namedTables(statement: string): string[] {
  // A name may carry its schema (`"agent"."agent_thread"`, with `schema` set): the table is the last part.
  const quote = '[`"\']?';
  const name = `(?:${quote}[\\w$]+${quote}\\.)?${quote}([\\w$]+)`;
  const patterns = [
    new RegExp(String.raw`^create\s+table\s+(?:if\s+not\s+exists\s+)?${name}`, 'i'),
    new RegExp(String.raw`^create\s+(?:unique\s+)?index\s+.+?\s+on\s+${name}`, 'i'),
    new RegExp(String.raw`^alter\s+table\s+${name}`, 'i'),
    new RegExp(String.raw`^drop\s+table\s+(?:if\s+exists\s+)?${name}`, 'i'),
    new RegExp(String.raw`^insert\s+into\s+${name}`, 'i'),
    new RegExp(String.raw`\brename\s+to\s+${name}`, 'i'),
    new RegExp(String.raw`\bfrom\s+${name}`, 'i'),
  ];
  const tables: string[] = [];
  for (const pattern of patterns) {
    const name = statement.match(pattern)?.[1];
    if (name !== undefined) {
      tables.push(name.toLowerCase());
    }
  }
  return tables;
}

/**
 * A statement that creates or moves structure — its failure must abort the heal, not be swallowed.
 * The rebuild statements count: a copy, drop or rename that failed leaves the table half-rewritten.
 */
function isRequiredStructure(statement: string): boolean {
  return /\b(?:create\s+table|create\s+(?:unique\s+)?index|add\s+(?:column|index|constraint|key|unique|fulltext)|insert\s+into|drop\s+table|rename\s+to)\b/i.test(
    statement,
  );
}

type SqlDialect = 'mysql' | 'postgres' | 'sqlite' | 'unknown';

function detectDialect(em: EntityManager): SqlDialect {
  const platform = em.getPlatform().constructor.name.toLowerCase();
  if (platform.includes('mysql') || platform.includes('maria')) return 'mysql';
  if (platform.includes('postgre')) return 'postgres';
  if (platform.includes('sqlite') || platform.includes('libsql')) return 'sqlite';
  return 'unknown';
}

function computeExpectedFingerprint(orm: MikroORM): string {
  const ownedMetadata = [...orm.getMetadata().getAll().values()]
    .filter((meta) => AGENT_TABLE_NAMES.has(meta.tableName))
    .sort((a, b) => compareStrings(a.tableName, b.tableName));
  const tables = ownedMetadata.map((meta) => {
    const columns = [...meta.props]
      .map((prop) => ({ prop, columnName: prop.fieldNames[0] ?? String(prop.name) }))
      .sort((a, b) => compareStrings(a.columnName, b.columnName))
      .map(({ prop, columnName }) => ({
        name: columnName,
        type: prop.columnTypes?.[0] ?? String(prop.type),
        nullable: prop.nullable === true,
        primary: prop.primary === true,
        default: prop.default ?? null,
        collation: (prop as { collation?: string }).collation ?? null,
      }));
    const indexes = [...meta.indexes]
      .map((index) => ({
        name: index.name ?? '',
        properties: normalizeIndexProperties(index.properties),
      }))
      .sort((a, b) => compareStrings(a.name, b.name));
    return { tableName: meta.tableName, columns, indexes };
  });
  const canonical = `${canonicalize(tables)}|collate=${String(orm.config.get('collate') ?? '')}|rev=${SCHEMA_REVISION}`;
  return createHash('sha256').update(canonical).digest('hex');
}

function normalizeIndexProperties(properties: unknown): string[] {
  if (properties === undefined) return [];
  if (Array.isArray(properties)) return properties.map((property) => String(property));
  return [String(properties)];
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).sort(([a], [b]) => compareStrings(a, b));
    return `{${entries.map(([key, val]) => `${JSON.stringify(key)}:${canonicalize(val)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * `create table if not exists` the marker, outside the lock so a steady-state boot stays one read.
 * Postgres does not make that statement race-safe: two replicas booting an empty database at once
 * both pass the existence check and the loser fails on `pg_type_typname_nsp_index`. So a failure is
 * retried once under the schema lock, by which time the winner's table is there and the guard holds.
 */
async function createMarkerTable(
  em: EntityManager,
  dialect: SqlDialect,
  marker: Marker,
): Promise<void> {
  const connection = em.getConnection();
  try {
    await connection.execute(marker.createSql());
  } catch {
    await withSchemaLock(em, dialect, marker.schema, async () => {
      await connection.execute(marker.createSql());
    });
  }
}

/** The fingerprint marker table, in the agent tables' schema when one is configured. */
class Marker {
  private readonly table: string;

  constructor(
    em: EntityManager,
    readonly schema: string | undefined,
  ) {
    this.table = tableIn(em, MARKER_TABLE, schema);
  }

  createSql(): string {
    return `create table if not exists ${this.table} (id varchar(32) not null primary key, fingerprint varchar(64) not null, applied_at bigint not null)`;
  }

  async read(connection: Connection): Promise<string | undefined> {
    const rows = await connection.execute<{ fingerprint: string }[]>(
      `select fingerprint from ${this.table} where id = ?`,
      [MARKER_ROW_ID],
    );
    return rows[0]?.fingerprint;
  }

  async write(connection: Connection, dialect: SqlDialect, fingerprint: string): Promise<void> {
    const upsert =
      dialect === 'mysql'
        ? `insert into ${this.table} (id, fingerprint, applied_at) values (?, ?, ?) on duplicate key update fingerprint = values(fingerprint), applied_at = values(applied_at)`
        : `insert into ${this.table} (id, fingerprint, applied_at) values (?, ?, ?) on conflict (id) do update set fingerprint = excluded.fingerprint, applied_at = excluded.applied_at`;
    await connection.execute(upsert, [MARKER_ROW_ID, fingerprint, Date.now()]);
  }
}

/**
 * Run `work` holding the cross-replica schema lock (Postgres advisory lock, MySQL `get_lock`).
 *
 * Both are SESSION locks: whoever takes one must release it on the same connection, or it stays held
 * by whichever pooled connection took it — and every other replica's next heal then waits on it
 * forever (`pg_advisory_lock` has no timeout). A plain `connection.execute` borrows any pooled
 * connection per statement, so the lock is taken and released inside a transaction, which pins one
 * connection for its whole life; on Postgres it is the transaction-scoped `pg_advisory_xact_lock`,
 * released by the commit. `work` itself runs OUTSIDE that transaction, on the usual connections: the
 * heal tolerates a failed non-structural statement, which inside a Postgres transaction would abort
 * everything after it.
 */
async function withSchemaLock(
  em: EntityManager,
  dialect: SqlDialect,
  schema: string | undefined,
  work: () => Promise<void>,
): Promise<void> {
  // The lock names the schema, so two installs in two schemas of one database heal independently.
  const lockName = schema === undefined ? SCHEMA_LOCK_NAME : `${SCHEMA_LOCK_NAME}:${schema}`;
  if (dialect !== 'postgres' && dialect !== 'mysql') {
    await work();
    return;
  }
  await em.fork().transactional(async (locked) => {
    const connection = locked.getConnection();
    const ctx = locked.getTransactionContext();
    const run = (sql: string) => connection.execute(sql, [], 'all', ctx);
    try {
      await run(
        dialect === 'mysql'
          ? `select get_lock('${lockName}', 30)`
          : `select pg_advisory_xact_lock(hashtext('${lockName}'))`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[nestjs-agent-store-mikro-orm] could not acquire the agent-schema advisory lock (proceeding without it): ${message}`,
      );
      await work();
      return;
    }
    try {
      await work();
    } finally {
      if (dialect === 'mysql') {
        // best-effort: a dropped connection frees the lock anyway
        await run(`select release_lock('${lockName}')`).catch(() => undefined);
      }
    }
  });
}
