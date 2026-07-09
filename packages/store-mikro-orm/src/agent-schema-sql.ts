import { type Configuration, MikroORM } from '@mikro-orm/core';
import { agentEntities } from './entities';

export interface AgentSchemaSqlOptions {
  /**
   * Emit `create table if not exists` so re-running the DDL against a database that already has
   * some agent tables is a no-op for those tables. Default `true`. Applies to `create table` only —
   * `create index` / `alter table add constraint` stay plain, since MySQL 8 has no
   * `create index if not exists`; a once-run migration creates each table and its indexes together,
   * so the guard is only ever meaningful on the table statement.
   */
  ifNotExists?: boolean;
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
  const isolated = await MikroORM.init({
    driver: config.get('driver'),
    dbName: config.get('dbName'),
    entities: agentEntities(),
    allowGlobalContext: true,
  });
  try {
    const sql = await isolated.schema.getCreateSchemaSQL({ wrap: false });
    return toStatements(sql, options?.ifNotExists ?? true);
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
