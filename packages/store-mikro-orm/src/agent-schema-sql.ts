import { type Configuration, EntitySchema, MikroORM } from '@mikro-orm/core';
import { agentEntities } from './entities';
import { assertAgentSchema, platformOf } from './schema-name';

export interface AgentSchemaSqlOptions {
  /**
   * Render every table in this schema (Postgres) or database (MySQL), preceded by its
   * `create schema` / `create database`. Omit → unqualified, the connection's current one.
   */
  schema?: string;
  /**
   * Emit `create table if not exists` so re-running the DDL against a database that already has
   * some agent tables is a no-op for those tables. Default `true`. Applies to `create table` only —
   * `create index` / `alter table add constraint` stay plain, since MySQL 8 has no
   * `create index if not exists`; a once-run migration creates each table and its indexes together,
   * so the guard is only ever meaningful on the table statement.
   */
  ifNotExists?: boolean;
  /**
   * The string collation to render. Default: whatever the host registered the agent entities with
   * (`AGENT_ENTITIES` carries `utf8mb4_unicode_ci`), read off the config; none when it registered
   * them without one.
   */
  collation?: string;
}

/**
 * The collation the host's own agent entities carry, so the DDL rendered here matches the schema
 * `ensureAgentSchema` diffs against. Rendering without it made every key column on MySQL differ in
 * collation from what the entities declare — and those are exactly the columns MySQL refuses to
 * `modify` while a foreign key points at them, so the heal warned about them on every boot after.
 */
function hostCollation(config: Configuration): string | undefined {
  const entities = (config.get('entities') ?? []) as unknown[];
  for (const entity of entities) {
    if (entity instanceof EntitySchema && entity.meta.tableName === 'agent_thread') {
      const id = entity.meta.properties.id as { collation?: string } | undefined;
      return id?.collation;
    }
  }
  return undefined;
}

/**
 * The agent store's schema as an ordered list of `create table` / `create index` /
 * `alter table` statements, rendered from the entity metadata in the host ORM's own dialect — so
 * MySQL collation/charset/engine, Postgres types, etc. all come out right without hand-transcribing
 * DDL. Metadata-only: it spins up a throwaway ORM over just the agent entities — `MikroORM.init`
 * discovers metadata without opening a connection, and `getCreateSchemaSQL` renders purely from that
 * metadata — so it never touches the live database (unlike {@link ensureAgentSchema}'s
 * `schema.update`, which introspects and can deadlock a shared boot).
 *
 * Drop it into a migration to keep the agent tables in lockstep with the lib as it evolves. Pass
 * either a `MikroORM` instance or, inside a MikroORM `Migration`, the `this.config` it exposes:
 *
 * ```ts
 * export class Migration2026… extends Migration {
 *   override async up(): Promise<void> {
 *     for (const sql of await agentSchemaSql(this.config)) {
 *       this.addSql(sql);
 *     }
 *   }
 * }
 * ```
 */
export async function agentSchemaSql(
  source: MikroORM | Configuration,
  options?: AgentSchemaSqlOptions,
): Promise<string[]> {
  // Accept either an ORM (has `.config`) or a Configuration directly — a `Migration` only gets the
  // latter via `this.config`, and that's the primary place this helper is called.
  const config = 'config' in source ? source.config : source;
  const collation = options?.collation ?? hostCollation(config);
  const isolated = await MikroORM.init({
    driver: config.get('driver'),
    dbName: config.get('dbName'),
    entities: agentEntities(collation !== undefined ? { collation } : {}),
    allowGlobalContext: true,
    // The generator places the agent entities (they name no schema) in the configured default.
    ...(options?.schema !== undefined ? { schema: options.schema } : {}),
  });
  try {
    const schema = options?.schema;
    assertAgentSchema(isolated.em, schema);
    const sql = await isolated.schema.getCreateSchemaSQL({
      wrap: false,
      ...(schema !== undefined ? { schema } : {}),
    });
    const statements = toStatements(sql, options?.ifNotExists ?? true);
    if (schema === undefined) return statements;
    const mysql = platformOf(isolated.em) === 'mysql';
    const create = mysql
      ? `create database if not exists \`${schema}\``
      : `create schema if not exists "${schema}"`;
    // The generator may emit its own `create schema`; keep one, first.
    return [
      create,
      ...statements.filter((statement) => !/^create\s+(schema|database)\b/i.test(statement)),
    ];
  } finally {
    await isolated.close(true);
  }
}

/** Split the rendered DDL into individual, trimmed statements (our entities carry no inline `;`). */
function toStatements(sql: string, ifNotExists: boolean): string[] {
  const statements = sql
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
  if (!ifNotExists) {
    return statements;
  }
  return statements.map((statement) =>
    statement.replace(/^create table (?!if not exists)/i, 'create table if not exists '),
  );
}
