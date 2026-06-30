import { Parser } from 'node-sql-parser';

const parser = new Parser();

/**
 * Ensures a SELECT returns at most `max` rows. If the statement already carries
 * a LIMIT it is returned unchanged; otherwise it is wrapped in a bounding
 * subquery (`SELECT * FROM (<sql>) AS subq LIMIT <max>`) so any ORDER BY /
 * GROUP BY / UNION inside `sql` is preserved.
 */
export function injectLimit(sql: string, max: number): string {
  const trimmed = sql.trim().replace(/;\s*$/, '');
  if (hasLimit(trimmed)) return trimmed;
  return `SELECT * FROM (${trimmed}) AS subq LIMIT ${max}`;
}

function hasLimit(sql: string): boolean {
  try {
    const parsed = parser.astify(sql, { database: 'MySQL' });
    const statement = (Array.isArray(parsed) ? parsed[0] : parsed) as
      | { limit?: { value?: unknown[] } | null }
      | undefined;
    const limit = statement?.limit;
    return Boolean(limit && Array.isArray(limit.value) && limit.value.length > 0);
  } catch {
    // If we can't parse it here, fall back to wrapping — the validator already
    // ran and accepted it, so wrapping is the safe choice.
    return false;
  }
}
