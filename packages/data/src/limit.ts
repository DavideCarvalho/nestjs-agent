import { Parser } from 'node-sql-parser';

const parser = new Parser();

/**
 * Ensures a SELECT returns at most `max` rows. A statement whose own LIMIT is
 * already within `max` is returned unchanged; otherwise — no LIMIT, or one above
 * `max` — it is wrapped in a bounding subquery
 * (`SELECT * FROM (<sql>) AS subq LIMIT <max>`) so any ORDER BY / GROUP BY /
 * UNION / OFFSET inside `sql` is preserved.
 */
export function injectLimit(sql: string, max: number): string {
  const trimmed = sql.trim().replace(/;\s*$/, '');
  const limit = rowLimit(trimmed);
  if (limit !== undefined && limit <= max) return trimmed;
  return `SELECT * FROM (${trimmed}) AS subq LIMIT ${max}`;
}

/** The row count the statement's own LIMIT allows; undefined when there is none or it can't tell. */
function rowLimit(sql: string): number | undefined {
  try {
    const parsed = parser.astify(sql, { database: 'MySQL' });
    const statement = (Array.isArray(parsed) ? parsed[0] : parsed) as
      | { limit?: { seperator?: string; value?: Array<{ type?: string; value?: unknown }> } | null }
      | undefined;
    const limit = statement?.limit;
    if (!limit || !Array.isArray(limit.value) || limit.value.length === 0) return undefined;
    // `LIMIT <offset>, <count>` puts the count second; `LIMIT <count> [OFFSET <offset>]`, first.
    const count = limit.seperator === ',' ? limit.value[1] : limit.value[0];
    return count?.type === 'number' && typeof count.value === 'number' ? count.value : undefined;
  } catch {
    // If we can't parse it here, fall back to wrapping — the validator already
    // ran and accepted it, so wrapping is the safe choice.
    return undefined;
  }
}
