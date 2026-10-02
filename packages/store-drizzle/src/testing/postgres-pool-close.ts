import type { Pool } from 'pg';

/** pg-pool can resolve end() before its removed idle clients finish disconnecting. */
export function trackPostgresPoolShutdown(pool: Pool): () => Promise<void> {
  const disconnecting = new Set<Promise<void>>();
  pool.on('connect', (client) => {
    const ended = new Promise<void>((resolve) => {
      client.once('end', () => {
        disconnecting.delete(ended);
        resolve();
      });
    });
    disconnecting.add(ended);
  });
  return async () => {
    await pool.end();
    // No new clients can connect after the pool finishes ending. Await protocol/socket closure
    // before dropping the database, rather than terminating still-disconnecting clients.
    await Promise.all(disconnecting);
  };
}
