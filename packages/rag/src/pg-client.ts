/**
 * The minimal Postgres surface {@link import('./pg-vector-store.js').PgVectorStore} needs — adapt your
 * own `pg` / `postgres.js` client to it, so this package pulls in NO driver (bring your own, like the
 * store adapters take an ORM handle and the Redis transport takes a client). `query` runs
 * parameterized SQL (`$1,$2,…`) and resolves the result rows.
 *
 * `transaction` is optional. When present, the store uses it for the few reads that must share one
 * connection with a `SET LOCAL` (pgvector's iterative index scan); without it those settings are
 * simply not applied. You rarely write either by hand: pass a `pg` `Pool`, a Drizzle database or a
 * `postgres.js` `sql` and {@link toPgClient} builds both.
 */
export interface PgClient {
  query<Row = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<Row[]>;
  /** Run `work` inside one transaction on one connection; commit on success, roll back on throw. */
  transaction?<T>(work: (tx: PgClient) => Promise<T>): Promise<T>;
}

/**
 * A node-postgres `Pool`, `PoolClient` or `Client` — anything whose `query(text, values)` resolves a
 * result with `rows`. Typed structurally so this package needs no `pg` import.
 */
export interface NodePgQueryable {
  query(text: string, values?: any[]): Promise<unknown>;
}

/** A `postgres.js` `sql` instance (or a transaction handle from `sql.begin`). */
export interface PostgresJsSql {
  unsafe(query: string, params?: any[]): PromiseLike<unknown>;
  begin?(...args: any[]): PromiseLike<unknown>;
}

/**
 * A Drizzle database — `drizzle(pool)` for node-postgres or `drizzle(sql)` for postgres.js. Drizzle
 * exposes the driver it wraps as `$client`, which is what the store talks to; this saves the
 * `(db as unknown as { $client: Pool }).$client` cast at every call site.
 */
export interface DrizzleLike {
  $client: NodePgQueryable | PostgresJsSql;
}

/** Everything {@link toPgClient} (and so the `PgVectorStore` constructor) accepts. */
export type PgClientSource = PgClient | NodePgQueryable | PostgresJsSql | DrizzleLike;

const ADAPTED = Symbol.for('@dudousxd/nestjs-agent-rag/pg-client');

/**
 * Normalize a Postgres handle into a {@link PgClient}:
 *
 * - a Drizzle database → its `$client`, then one of the below;
 * - a `postgres.js` `sql` → `sql.unsafe(text, params)`, transactions via `sql.begin`;
 * - a node-postgres `Pool` → `pool.query(...).rows`, transactions on a checked-out client
 *   (`BEGIN`/`COMMIT`/`ROLLBACK`, then `release()`); a single `Client`/`PoolClient` runs its
 *   transaction in place;
 * - a hand-written {@link PgClient} (`query` resolving the rows array) passes through unchanged.
 *
 * Detection is structural and happens per call result for `query` (an array is taken as the rows, an
 * object's `rows` otherwise), so a hand-written adapter keeps working exactly as before.
 */
export function toPgClient(source: PgClientSource): PgClient {
  if ((source as { [ADAPTED]?: true })[ADAPTED]) {
    return source as PgClient;
  }
  if (isDrizzle(source)) {
    return toPgClient(source.$client);
  }
  if (typeof (source as PostgresJsSql).unsafe === 'function') {
    return fromPostgresJs(source as PostgresJsSql);
  }
  return fromQueryable(source as NodePgQueryable & Partial<PgClient>);
}

function isDrizzle(source: PgClientSource): source is DrizzleLike {
  const client = (source as Partial<DrizzleLike>).$client;
  return client !== null && client !== undefined && typeof client === 'object';
}

function mark(client: PgClient): PgClient {
  Object.defineProperty(client, ADAPTED, { value: true });
  return client;
}

function rowsOf<Row>(result: unknown): Row[] {
  if (Array.isArray(result)) {
    return result as Row[];
  }
  const rows = (result as { rows?: unknown } | null | undefined)?.rows;
  return Array.isArray(rows) ? (rows as Row[]) : [];
}

function fromPostgresJs(sql: PostgresJsSql): PgClient {
  const client: PgClient = {
    query: async <Row>(text: string, params: unknown[] = []) =>
      // postgres.js resolves a RowList (an Array subclass); copy it to a plain array.
      [...rowsOf<Row>(await sql.unsafe(text, params))],
  };
  if (typeof sql.begin === 'function') {
    const begin = sql.begin.bind(sql);
    client.transaction = <T>(work: (tx: PgClient) => Promise<T>) =>
      Promise.resolve(begin((tx: PostgresJsSql) => work(fromPostgresJs(tx)))) as Promise<T>;
  }
  return mark(client);
}

interface NodePgPoolLike extends NodePgQueryable {
  connect(): Promise<NodePgQueryable & { release(error?: unknown): void }>;
  totalCount: number;
}

function fromQueryable(source: NodePgQueryable & Partial<PgClient>): PgClient {
  const client: PgClient = {
    query: async <Row>(text: string, params?: unknown[]) =>
      rowsOf<Row>(await source.query(text, params)),
  };
  if (typeof source.transaction === 'function') {
    // A hand-written PgClient that already knows how to run a transaction.
    const transaction = source.transaction.bind(source);
    client.transaction = <T>(work: (tx: PgClient) => Promise<T>) =>
      transaction((tx: PgClient) => work(toPgClient(tx)));
  } else if (isNodePgPool(source)) {
    client.transaction = async <T>(work: (tx: PgClient) => Promise<T>) => {
      const connection = await source.connect();
      let broken = false;
      try {
        return await runInTransaction(connection, work, () => {
          broken = true;
        });
      } finally {
        // A connection whose ROLLBACK failed is not safe to hand back to the pool: a truthy
        // argument makes node-postgres destroy it instead.
        connection.release(broken ? new Error('ROLLBACK failed') : undefined);
      }
    };
  } else if (isNodePgClient(source)) {
    client.transaction = <T>(work: (tx: PgClient) => Promise<T>) => runInTransaction(source, work);
  }
  return mark(client);
}

async function runInTransaction<T>(
  connection: NodePgQueryable,
  work: (tx: PgClient) => Promise<T>,
  onRollbackFailed?: () => void,
): Promise<T> {
  const tx = mark({
    query: async <Row>(text: string, params?: unknown[]) =>
      rowsOf<Row>(await connection.query(text, params)),
  });
  await connection.query('BEGIN');
  try {
    const result = await work(tx);
    await connection.query('COMMIT');
    return result;
  } catch (error) {
    // The original error is what the caller needs; a failed ROLLBACK only poisons the connection.
    await connection.query('ROLLBACK').catch(() => onRollbackFailed?.());
    throw error;
  }
}

function isNodePgPool(source: object): source is NodePgPoolLike {
  return (
    typeof (source as Partial<NodePgPoolLike>).connect === 'function' &&
    typeof (source as Partial<NodePgPoolLike>).totalCount === 'number'
  );
}

/** A node-postgres `Client`/`PoolClient`: one connection, so a transaction runs on it directly. */
function isNodePgClient(source: object): boolean {
  return (
    typeof (source as { release?: unknown }).release === 'function' ||
    typeof (source as { processID?: unknown }).processID === 'number' ||
    (source as { connectionParameters?: unknown }).connectionParameters !== undefined
  );
}
