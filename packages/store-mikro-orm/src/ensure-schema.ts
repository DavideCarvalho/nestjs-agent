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
]);

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
 * statements that target an agent table. `safe` means create + add-column only; existing columns are
 * never dropped or altered.
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
    await healAgentSchema(em);
    await writeFingerprint(connection, dialect, expected);
  } finally {
    await releaseSchemaLock(connection, dialect);
  }
}

async function healAgentSchema(em: EntityManager): Promise<void> {
  const connection = em.getConnection();
  for (const statement of await agentUpdateStatements(em)) {
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

function belongsToAgent(statement: string): boolean {
  const table = targetTable(statement);
  return table !== undefined && AGENT_TABLE_NAMES.has(table);
}

/** The table a `create table` / `create index … on` / `alter table` statement targets, lowercased. */
function targetTable(statement: string): string | undefined {
  const match = statement.match(
    /^(?:create\s+(?:unique\s+)?index\s+.+?\s+on\s+|(?:create|alter)\s+table\s+(?:if\s+not\s+exists\s+)?)[`"']?([\w$]+)[`"']?/i,
  );
  return match?.[1]?.toLowerCase();
}

/** A statement that creates or adds structure — its failure must abort the heal, not be swallowed. */
function isRequiredStructure(statement: string): boolean {
  return /\b(?:create\s+table|create\s+(?:unique\s+)?index|add\s+(?:column|index|constraint|key|unique|fulltext))\b/i.test(
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
