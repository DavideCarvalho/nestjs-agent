import type { EntityManager, EntityMetadata } from '@mikro-orm/core';

/**
 * MySQL column collations, reconciled by hand.
 *
 * The agent entities declare a collation on every string column (`utf8mb4_unicode_ci`, and the
 * BINARY `utf8mb4_bin` on the columns whose values are compared exactly — actor refs, provider
 * message ids, proposal keys). MikroORM before 7.2 renders neither the `collate` clause in
 * `create table` / `add column` nor a collation difference in the schema diff, so every column the
 * heal created came out in the table's default collation (`utf8mb4_0900_ai_ci` on MySQL 8:
 * case-insensitive) and stayed that way on every later boot. Newer MikroORM diffs the collation but
 * emits a bare `modify`, which MySQL refuses on a key a foreign key points at.
 *
 * So on MySQL the heal reads the actual collation of every agent column from
 * `information_schema.columns` and corrects the ones that differ from the entity metadata itself:
 * one `alter table … modify` per table, all of them on one connection with `foreign_key_checks`
 * off, so a referenced key and the columns referencing it change together. Before it touches
 * anything it checks that the change cannot break a row — two keys that are distinct today but
 * equal under the new collation (`'abc'` / `'ABC'` going to a case-insensitive one) or a child row
 * that only matched its parent case-insensitively — and refuses with {@link AgentSchemaCollationError}
 * when one would.
 */

/** The collation the agent entities declare for a column, keyed `table.column`. */
type DeclaredCollations = Map<string, string>;

interface ColumnRow {
  table_name: string;
  column_name: string;
  collation_name: string | null;
  column_type: string;
  is_nullable: string;
  column_default: string | null;
  extra: string | null;
  column_comment: string | null;
}

interface ColumnChange {
  table: string;
  column: string;
  from: string;
  to: string;
  row: ColumnRow;
}

/**
 * Correcting a column's collation would break rows: keys that collide, or children that lose their
 * parent, under the declared collation. Nothing was altered and the schema fingerprint was not
 * recorded, so the next boot checks again once the rows are fixed.
 */
export class AgentSchemaCollationError extends Error {
  constructor(readonly conflicts: string[]) {
    super(
      `[nestjs-agent-store-mikro-orm] cannot correct the collation of agent columns: ${conflicts.join('; ')}. These rows are distinct under the column's current collation but not under the one the agent entities declare (or the other way round). Nothing was altered and the schema fingerprint was NOT recorded. Merge, rename or delete the conflicting rows (they differ only by case or accents), then restart: the next boot corrects the columns.`,
    );
    this.name = 'AgentSchemaCollationError';
  }
}

/** Every `table.column` of the given agent tables that declares a collation, with that collation. */
export function declaredCollations(metadata: EntityMetadata[]): DeclaredCollations {
  const declared: DeclaredCollations = new Map();
  for (const meta of metadata) {
    for (const prop of meta.props) {
      const collation = (prop as { collation?: string }).collation;
      if (collation === undefined || prop.fieldNames === undefined) continue;
      for (const field of prop.fieldNames) {
        declared.set(`${meta.tableName}.${field}`, collation);
      }
    }
  }
  return declared;
}

/**
 * Bring every agent column whose collation differs from the declared one to the declared one, on
 * MySQL. Returns the columns it changed (`table.column`); a no-op returns `[]`.
 */
export async function reconcileMySqlCollations(
  em: EntityManager,
  declared: DeclaredCollations,
): Promise<string[]> {
  if (declared.size === 0) return [];
  for (const collation of declared.values()) {
    if (!/^\w+$/.test(collation)) {
      throw new Error(
        `[nestjs-agent-store-mikro-orm] invalid column collation name: '${collation}'`,
      );
    }
  }
  const tables = [...new Set([...declared.keys()].map((key) => key.split('.')[0] as string))];
  const changes = await collationChanges(em, tables, declared);
  if (changes.length === 0) return [];

  await assertNoConflicts(em, changes, declared, tables);

  const byTable = new Map<string, ColumnChange[]>();
  for (const change of changes) {
    byTable.set(change.table, [...(byTable.get(change.table) ?? []), change]);
  }
  const platform = em.getPlatform();
  // One connection for the whole correction: `foreign_key_checks` is a session variable, and it is
  // what lets a referenced key and its referencing columns change collation one table at a time.
  await em.fork().transactional(async (locked) => {
    const connection = locked.getConnection();
    const ctx = locked.getTransactionContext();
    const run = (sql: string) => connection.execute(sql, [], 'all', ctx);
    await run('set foreign_key_checks = 0');
    try {
      for (const [table, columns] of byTable) {
        const modifies = columns.map(
          (change) => `modify ${quote(change.column)} ${columnDefinition(change, platform)}`,
        );
        await run(`alter table ${quote(table)} ${modifies.join(', ')}`);
      }
    } finally {
      await run('set foreign_key_checks = 1');
    }
  });

  const left = await collationChanges(em, tables, declared);
  if (left.length > 0) {
    throw new AgentSchemaCollationError(
      left.map((change) => `${change.table}.${change.column} is still ${change.from}`),
    );
  }
  return changes.map((change) => `${change.table}.${change.column}`);
}

async function collationChanges(
  em: EntityManager,
  tables: string[],
  declared: DeclaredCollations,
): Promise<ColumnChange[]> {
  const rows = await em
    .getConnection()
    .execute<ColumnRow[]>(
      `select table_name as table_name, column_name as column_name, collation_name as collation_name, column_type as column_type, is_nullable as is_nullable, column_default as column_default, extra as extra, column_comment as column_comment from information_schema.columns where table_schema = database() and table_name in (${tables.map(() => '?').join(', ')}) order by table_name, ordinal_position`,
      tables,
    );
  const changes: ColumnChange[] = [];
  for (const row of rows) {
    const to = declared.get(`${row.table_name}.${row.column_name}`);
    // No collation: not a character column (a json column declaring one has nothing to correct).
    if (to === undefined || row.collation_name === null) continue;
    if (row.collation_name.toLowerCase() === to.toLowerCase()) continue;
    changes.push({
      table: row.table_name,
      column: row.column_name,
      from: row.collation_name,
      to,
      row,
    });
  }
  return changes;
}

/**
 * Refuse the correction when it would break a row, before anything is altered:
 * - a unique key (the primary key included) touching a changed column holds two rows that are
 *   distinct today and equal under the declared collations;
 * - a foreign key touching a changed column has a child whose value only matched its parent under
 *   the current collation (`'ABC'` referencing `'abc'` case-insensitively).
 */
async function assertNoConflicts(
  em: EntityManager,
  changes: ColumnChange[],
  declared: DeclaredCollations,
  tables: string[],
): Promise<void> {
  const connection = em.getConnection();
  const changed = new Set(changes.map((change) => `${change.table}.${change.column}`));
  const placeholders = tables.map(() => '?').join(', ');
  const conflicts: string[] = [];

  const uniqueRows = await connection.execute<
    { table_name: string; index_name: string; column_name: string }[]
  >(
    `select table_name as table_name, index_name as index_name, column_name as column_name from information_schema.statistics where table_schema = database() and non_unique = 0 and table_name in (${placeholders}) order by table_name, index_name, seq_in_index`,
    tables,
  );
  const uniques = new Map<string, { table: string; index: string; columns: string[] }>();
  for (const row of uniqueRows) {
    const id = `${row.table_name}.${row.index_name}`;
    const entry = uniques.get(id) ?? { table: row.table_name, index: row.index_name, columns: [] };
    entry.columns.push(row.column_name);
    uniques.set(id, entry);
  }
  for (const { table, index, columns } of uniques.values()) {
    if (!columns.some((column) => changed.has(`${table}.${column}`))) continue;
    const keys = columns.map((column) => compared(column, declared.get(`${table}.${column}`)));
    const rows = await connection.execute<{ sample: string; n: number | string }[]>(
      `select min(${quote(columns[0] as string)}) as sample, count(*) as n from ${quote(table)} group by ${keys.join(', ')} having count(*) > 1 limit 5`,
    );
    for (const row of rows) {
      conflicts.push(
        `${table}.${index} (${columns.join(', ')}) would hold ${row.n} rows as one key, e.g. ${JSON.stringify(row.sample)}`,
      );
    }
  }

  const foreignRows = await connection.execute<
    {
      table_name: string;
      column_name: string;
      constraint_name: string;
      referenced_table_name: string;
      referenced_column_name: string;
    }[]
  >(
    `select table_name as table_name, column_name as column_name, constraint_name as constraint_name, referenced_table_name as referenced_table_name, referenced_column_name as referenced_column_name from information_schema.key_column_usage where table_schema = database() and referenced_table_name is not null and table_name in (${placeholders})`,
    tables,
  );
  for (const fk of foreignRows) {
    const child = `${fk.table_name}.${fk.column_name}`;
    const parent = `${fk.referenced_table_name}.${fk.referenced_column_name}`;
    if (!changed.has(child) && !changed.has(parent)) continue;
    // Compared the way the key will compare once both sides carry the parent's declared collation.
    const collation = declared.get(parent) ?? declared.get(child);
    const rows = await connection.execute<{ sample: string; n: number | string }[]>(
      `select min(c.${quote(fk.column_name)}) as sample, count(*) as n from ${quote(fk.table_name)} c where c.${quote(fk.column_name)} is not null and not exists (select 1 from ${quote(fk.referenced_table_name)} p where ${compared(`p.${quote(fk.referenced_column_name)}`, collation, true)} = ${compared(`c.${quote(fk.column_name)}`, collation, true)}) having count(*) > 0`,
    );
    for (const row of rows) {
      conflicts.push(
        `${row.n} row(s) of ${child} would no longer match ${parent} (foreign key ${fk.constraint_name}), e.g. ${JSON.stringify(row.sample)}`,
      );
    }
  }

  if (conflicts.length > 0) {
    throw new AgentSchemaCollationError(conflicts);
  }
}

/** `column` as compared under `collation` (converted to its character set first), or as-is. */
function compared(column: string, collation: string | undefined, quoted = false): string {
  const name = quoted ? column : quote(column);
  if (collation === undefined) return name;
  return `convert(${name} using ${charsetOf(collation)}) collate ${collation}`;
}

/** The column as it stands, with only its character set and collation replaced. */
function columnDefinition(
  change: ColumnChange,
  platform: { quoteValue(value: unknown): string },
): string {
  const { row, to } = change;
  const parts = [row.column_type, `character set ${charsetOf(to)}`, `collate ${to}`];
  parts.push(row.is_nullable.toUpperCase() === 'YES' ? 'null' : 'not null');
  if (row.column_default !== null) {
    parts.push(
      /default_generated/i.test(row.extra ?? '')
        ? `default (${row.column_default})`
        : `default ${platform.quoteValue(row.column_default)}`,
    );
  } else if (row.is_nullable.toUpperCase() === 'YES') {
    parts.push('default null');
  }
  if (row.column_comment) {
    parts.push(`comment ${platform.quoteValue(row.column_comment)}`);
  }
  return parts.join(' ');
}

function charsetOf(collation: string): string {
  return collation.split('_')[0] as string;
}

function quote(identifier: string): string {
  return `\`${identifier.replaceAll('`', '``')}\``;
}
