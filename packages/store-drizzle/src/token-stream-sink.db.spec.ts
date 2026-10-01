// Integration: DrizzleTokenStreamSink on SQLite, Postgres and MySQL — two "replicas" are two pools
// over one database wherever the dialect allows it. Runs only under `pnpm test:db`.
import { SQL_TOKEN_STREAM_SINK_CONTRACT } from '@dudousxd/nestjs-agent-testing';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, it } from 'vitest';
import type { AgentDrizzleDb } from './dialect.js';
import { DrizzleTokenStreamSink } from './drizzle-token-stream-sink.js';
import { type AgentDbHandle, describeEachDialect, openAgentDb } from './testing/real-db.js';

describeEachDialect('DrizzleTokenStreamSink — the SQL sink contract', (dialect) => {
  let handle: AgentDbHandle;
  let replicas: AgentDrizzleDb[];

  beforeAll(async () => {
    handle = await openAgentDb(dialect);
    replicas = [handle.db, await handle.replica()];
  });

  afterAll(async () => {
    await handle?.close();
  });

  // The purge cases count what they purged, so each case starts from an empty table.
  beforeEach(async () => {
    await handle.run('delete from agent_stream_frame');
  });

  for (const contractCase of SQL_TOKEN_STREAM_SINK_CONTRACT) {
    it(contractCase.name, async () => {
      const { q, t } = handle;
      await contractCase.run(
        {
          sinkOn: (replica, options) =>
            new DrizzleTokenStreamSink(replicas[replica] ?? handle.db, options),
          rowCount: async (runId) =>
            (await q.select().from(t.agentStreamFrame).where(eq(t.agentStreamFrame.runId, runId)))
              .length,
          seqs: async (runId) =>
            (
              await q
                .select({ seq: t.agentStreamFrame.seq })
                .from(t.agentStreamFrame)
                .where(eq(t.agentStreamFrame.runId, runId))
                .orderBy(asc(t.agentStreamFrame.seq))
            ).map((row) => row.seq),
          insertRow: async (runId, seq, frame, createdAt) => {
            await q
              .insert(t.agentStreamFrame)
              .values({ runId, seq, frame, error: null, createdAt });
          },
        },
        `run-${crypto.randomUUID()}`,
      );
    });
  }
});
