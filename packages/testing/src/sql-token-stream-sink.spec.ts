import { SqlTokenStreamSink } from '@dudousxd/nestjs-agent-core';
import { describe, it } from 'vitest';
import { InMemoryStreamFrameTable } from './in-memory-stream-frame-table.js';
import { SQL_TOKEN_STREAM_SINK_CONTRACT } from './sql-token-stream-sink-contract.js';

describe('SqlTokenStreamSink over an in-memory table — the SQL sink contract', () => {
  for (const contractCase of SQL_TOKEN_STREAM_SINK_CONTRACT) {
    it(contractCase.name, async () => {
      const table = new InMemoryStreamFrameTable();
      await contractCase.run(
        {
          sinkOn: (_replica, options) => new SqlTokenStreamSink(table, options),
          rowCount: async (runId) => table.rows.get(runId)?.length ?? 0,
          seqs: async (runId) => (table.rows.get(runId) ?? []).map((row) => row.seq),
          insertRow: (runId, seq, frame, createdAt) =>
            table.insertRaw(runId, { seq, frame, error: null, createdAt }),
        },
        `run-${crypto.randomUUID()}`,
      );
    });
  }
});
