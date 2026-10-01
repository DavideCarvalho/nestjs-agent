import type { StreamFrameRow, StreamFrameTable } from '@dudousxd/nestjs-agent-core';

interface StoredRow extends StreamFrameRow {
  createdAt: number;
}

/**
 * A {@link StreamFrameTable} in a Map — the SQL sink's logic without a database, for unit tests.
 * Several `SqlTokenStreamSink`s over ONE instance behave as replicas sharing a database.
 */
export class InMemoryStreamFrameTable implements StreamFrameTable {
  readonly rows = new Map<string, StoredRow[]>();

  async append(
    runId: string,
    row: { frame: string | null; error: string | null; createdAt: number },
  ): Promise<void> {
    const rows = this.rows.get(runId) ?? [];
    rows.push({ seq: rows.length + 1, ...row });
    this.rows.set(runId, rows);
  }

  async read(runId: string, after: number, limit: number): Promise<StreamFrameRow[]> {
    return (this.rows.get(runId) ?? [])
      .filter((row) => row.seq > after)
      .slice(0, limit)
      .map(({ seq, frame, error }) => ({ seq, frame, error }));
  }

  async has(runId: string): Promise<boolean> {
    return (this.rows.get(runId)?.length ?? 0) > 0;
  }

  async remove(runIds: readonly string[]): Promise<void> {
    for (const runId of runIds) this.rows.delete(runId);
  }

  async lapsedRuns(cutoff: number): Promise<string[]> {
    return [...this.rows]
      .filter(([, rows]) => Math.max(...rows.map((row) => row.createdAt)) < cutoff)
      .map(([runId]) => runId);
  }

  isUniqueViolation(): boolean {
    return false;
  }

  /** Insert a row as another replica (or the past) would have: for TTL tests. */
  async insertRaw(runId: string, row: StoredRow): Promise<void> {
    const rows = this.rows.get(runId) ?? [];
    rows.push(row);
    this.rows.set(runId, rows);
  }
}
