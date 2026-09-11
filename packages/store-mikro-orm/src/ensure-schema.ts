import { createHash } from 'node:crypto';
import type { Connection, EntityManager, MikroORM } from '@mikro-orm/core';

/**
 * The tables this store owns. The schema heal and fingerprint are scoped to exactly these, so
 * `ensureAgentSchema` never touches (or diffs) the host app's own tables on a shared database.
 */
const AGENT_TABLE_NAMES = new Set([
  'agent_thread',
  'agent_message',
  'agent_tool_call',
  'agent_token_usage',
  'agent_model_pricing',
  'agent_run',
  'rag_ingestion_log',
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
/** Bump to force a re-heal on the next boot even when the entity metadata is unchanged. */
const SCHEMA_REVISION = 1;

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
 * uses in place of `add column`. `safe` means create + add-column only; existing columns are never
 * dropped or altered.
 *
 * What the heal applied is then re-diffed, and a heal that left required structure pending throws
 * {@link AgentSchemaHealError} — the fingerprint is written only on the way out, so a boot that
 * healed nothing cannot record itself as the applied schema and silence every boot after it.
 */
export async function ensureAgentSchema(orm: MikroORM): Promise<void> {
  const em = orm.em;
  const connection = em.getConnection();
  const dialect = detectDialect(em);

  await connection.execute(createMarkerTableSql());
  const expected = computeExpectedFingerprint(orm);
  if ((await readStoredFingerprint(connection)) === expected) {
    return;
  }

  await acquireSchemaLock(connection, dialect);
  try {
    // Re-read under the lock: another replica may have healed while we waited.
    if ((await readStoredFingerprint(connection)) === expected) {
      return;
    }
    await healAgentSchema(em, dialect);
    await writeFingerprint(connection, dialect, expected);
  } finally {
    await releaseSchemaLock(connection, dialect);
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

async function healAgentSchema(em: EntityManager, dialect: SqlDialect): Promise<void> {
  const connection = em.getConnection();
  const statements = await agentUpdateStatements(em);
  if (statements.length === 0) {
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
  const pending = (await agentUpdateStatements(em)).filter(isRequiredStructure);
  if (pending.length > 0) {
    throw new AgentSchemaHealError(pending);
  }
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
async function agentUpdateStatements(em: EntityManager): Promise<string[]> {
  // A generator built from the platform (not `orm.schema`) carries no `schemaGenerator.skipTables`,
  // so it sees the agent tables even when the host excludes `agent_` from its own snapshot diff.
  const generator = em.getPlatform().getSchemaGenerator(em.getDriver(), em);
  const sql = await generator.getUpdateSchemaSQL({ safe: true, wrap: false });
  return sql
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0 && belongsToAgent(statement));
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
  const patterns = [
    /^create\s+table\s+(?:if\s+not\s+exists\s+)?[`"']?([\w$]+)/i,
    /^create\s+(?:unique\s+)?index\s+.+?\s+on\s+[`"']?([\w$]+)/i,
    /^alter\s+table\s+[`"']?([\w$]+)/i,
    /^drop\s+table\s+(?:if\s+exists\s+)?[`"']?([\w$]+)/i,
    /^insert\s+into\s+[`"']?([\w$]+)/i,
    /\brename\s+to\s+[`"']?([\w$]+)/i,
    /\bfrom\s+[`"']?([\w$]+)/i,
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

function createMarkerTableSql(): string {
  return `create table if not exists ${MARKER_TABLE} (id varchar(32) not null primary key, fingerprint varchar(64) not null, applied_at bigint not null)`;
}

async function readStoredFingerprint(connection: Connection): Promise<string | undefined> {
  const rows = await connection.execute<{ fingerprint: string }[]>(
    `select fingerprint from ${MARKER_TABLE} where id = ?`,
    [MARKER_ROW_ID],
  );
  return rows[0]?.fingerprint;
}

async function writeFingerprint(
  connection: Connection,
  dialect: SqlDialect,
  fingerprint: string,
): Promise<void> {
  const upsert =
    dialect === 'mysql'
      ? `insert into ${MARKER_TABLE} (id, fingerprint, applied_at) values (?, ?, ?) on duplicate key update fingerprint = values(fingerprint), applied_at = values(applied_at)`
      : `insert into ${MARKER_TABLE} (id, fingerprint, applied_at) values (?, ?, ?) on conflict (id) do update set fingerprint = excluded.fingerprint, applied_at = excluded.applied_at`;
  await connection.execute(upsert, [MARKER_ROW_ID, fingerprint, Date.now()]);
}

async function acquireSchemaLock(connection: Connection, dialect: SqlDialect): Promise<void> {
  try {
    if (dialect === 'mysql') {
      await connection.execute(`select get_lock('${SCHEMA_LOCK_NAME}', 10)`);
    } else if (dialect === 'postgres') {
      await connection.execute(`select pg_advisory_lock(hashtext('${SCHEMA_LOCK_NAME}'))`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[nestjs-agent-store-mikro-orm] could not acquire the agent-schema advisory lock (proceeding without it): ${message}`,
    );
  }
}

async function releaseSchemaLock(connection: Connection, dialect: SqlDialect): Promise<void> {
  try {
    if (dialect === 'mysql') {
      await connection.execute(`select release_lock('${SCHEMA_LOCK_NAME}')`);
    } else if (dialect === 'postgres') {
      await connection.execute(`select pg_advisory_unlock(hashtext('${SCHEMA_LOCK_NAME}'))`);
    }
  } catch {
    // best-effort release; a dropped connection frees the lock anyway
  }
}
