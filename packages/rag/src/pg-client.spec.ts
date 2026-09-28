// Unit: toPgClient normalizes every Postgres handle PgVectorStore accepts — a hand-written PgClient,
// a node-postgres Pool / Client, a Drizzle database and a postgres.js `sql` — into one rows-only
// surface with an optional transaction. Fakes mimic each driver's shape; the db suite proves the
// real `pg` Pool and Drizzle against a live Postgres.
import { describe, expect, it } from 'vitest';
import { type PgClient, toPgClient } from './pg-client.js';

interface Call {
  on: string;
  sql: string;
  params?: unknown[];
}

/** A node-postgres Pool look-alike: `query` resolves `{ rows }`, `connect` checks out a client. */
function fakePool(calls: Call[], options: { failOn?: string } = {}) {
  const released: unknown[] = [];
  const connection = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ on: 'conn', sql, ...(params ? { params } : {}) });
      if (options.failOn !== undefined && sql.startsWith(options.failOn)) {
        throw new Error(`boom: ${sql}`);
      }
      return { rows: [{ sql }] };
    },
    release: (error?: unknown) => {
      released.push(error);
    },
  };
  const pool = {
    totalCount: 0,
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ on: 'pool', sql, ...(params ? { params } : {}) });
      return { rows: [{ n: 1 }] };
    },
    connect: async () => connection,
  };
  return { pool, released };
}

describe('toPgClient', () => {
  it('passes a hand-written PgClient through: rows arrays stay rows arrays', async () => {
    const client: PgClient = { query: async <Row>() => [{ a: 1 }] as Row[] };
    const adapted = toPgClient(client);
    await expect(adapted.query('SELECT 1')).resolves.toEqual([{ a: 1 }]);
    expect(adapted.transaction).toBeUndefined();
  });

  it('keeps the transaction of a hand-written PgClient that has one', async () => {
    const seen: string[] = [];
    const client: PgClient = {
      query: async <Row>(sql: string) => {
        seen.push(sql);
        return [] as Row[];
      },
      transaction: async (work) => {
        seen.push('BEGIN*');
        return work(client);
      },
    };
    const result = await toPgClient(client).transaction?.(async (tx) => {
      await tx.query('SELECT 2');
      return 'done';
    });
    expect(result).toBe('done');
    expect(seen).toEqual(['BEGIN*', 'SELECT 2']);
  });

  it('reads `rows` off a node-postgres result and runs a Pool transaction on one checked-out client', async () => {
    const calls: Call[] = [];
    const { pool, released } = fakePool(calls);
    const client = toPgClient(pool);

    await expect(client.query('SELECT $1', [1])).resolves.toEqual([{ n: 1 }]);
    const rows = await client.transaction?.((tx) => tx.query('SELECT inside'));

    expect(rows).toEqual([{ sql: 'SELECT inside' }]);
    expect(calls.map((call) => `${call.on}:${call.sql}`)).toEqual([
      'pool:SELECT $1',
      'conn:BEGIN',
      'conn:SELECT inside',
      'conn:COMMIT',
    ]);
    expect(released).toEqual([undefined]);
  });

  it('rolls back, rethrows the original error and still releases the client', async () => {
    const calls: Call[] = [];
    const { pool, released } = fakePool(calls, { failOn: 'SELECT bad' });

    await expect(toPgClient(pool).transaction?.((tx) => tx.query('SELECT bad'))).rejects.toThrow(
      'boom: SELECT bad',
    );
    expect(calls.map((call) => call.sql)).toEqual(['BEGIN', 'SELECT bad', 'ROLLBACK']);
    expect(released).toEqual([undefined]);
  });

  it('destroys (releases with an error) a client whose ROLLBACK failed', async () => {
    const calls: Call[] = [];
    const { pool, released } = fakePool(calls, { failOn: 'ROLLBACK' });
    const poolWithFailingWork = {
      ...pool,
      connect: async () => {
        const connection = await pool.connect();
        return {
          ...connection,
          query: async (sql: string, params?: unknown[]) => {
            if (sql === 'SELECT bad') {
              throw new Error('original');
            }
            return connection.query(sql, params);
          },
        };
      },
    };
    const failing = toPgClient(poolWithFailingWork);

    await expect(failing.transaction?.((tx) => tx.query('SELECT bad'))).rejects.toThrow('original');
    expect(released).toHaveLength(1);
    expect(released[0]).toBeInstanceOf(Error);
  });

  it('unwraps a Drizzle database to its $client', async () => {
    const calls: Call[] = [];
    const { pool } = fakePool(calls);
    const db = { $client: pool, execute: async () => undefined };

    const client = toPgClient(db);
    await expect(client.query('SELECT 1')).resolves.toEqual([{ n: 1 }]);
    expect(typeof client.transaction).toBe('function');
  });

  it('adapts a postgres.js sql: unsafe(text, params) and begin(tx => …)', async () => {
    const calls: Call[] = [];
    const makeSql = (on: string) => {
      const rows = Object.assign([{ on }], { count: 1 });
      return {
        unsafe: async (sql: string, params?: unknown[]) => {
          calls.push({ on, sql, ...(params ? { params } : {}) });
          return rows;
        },
        begin: async (work: (tx: unknown) => Promise<unknown>) => work(makeSql('tx')),
      };
    };

    const client = toPgClient(makeSql('sql'));
    const plain = await client.query('SELECT $1', ['a']);
    const inTx = await client.transaction?.((tx) => tx.query('SELECT 2'));

    expect(plain).toEqual([{ on: 'sql' }]);
    expect(Array.isArray(plain)).toBe(true);
    expect(inTx).toEqual([{ on: 'tx' }]);
    expect(calls).toEqual([
      { on: 'sql', sql: 'SELECT $1', params: ['a'] },
      { on: 'tx', sql: 'SELECT 2', params: [] },
    ]);
  });

  it('is idempotent: an adapted client is returned as-is', () => {
    const adapted = toPgClient({ query: async () => [] });
    expect(toPgClient(adapted)).toBe(adapted);
  });
});
