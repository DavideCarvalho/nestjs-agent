import { SqlTokenStreamSink } from '@dudousxd/nestjs-agent-core';
import { describe, expect, it } from 'vitest';
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

describe('SqlTokenStreamSink — a subscriber that goes away', () => {
  it('stops polling a silent run as soon as its signal aborts', async () => {
    const table = new InMemoryStreamFrameTable();
    let reads = 0;
    const read = table.read.bind(table);
    table.read = (...args) => {
      reads += 1;
      return read(...args);
    };
    const sink = new SqlTokenStreamSink(table, { pollIntervalMs: 60_000 });
    const controller = new AbortController();
    const following = (async () => {
      for await (const _ of sink.subscribe('run-silent', { signal: controller.signal })) {
        // the run never writes
      }
      return 'finished';
    })();
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    const outcome = await Promise.race([
      following,
      new Promise((resolve) => setTimeout(() => resolve('still polling'), 200)),
    ]);
    expect(outcome).toBe('finished');
    expect(reads).toBe(1);
  });
});
