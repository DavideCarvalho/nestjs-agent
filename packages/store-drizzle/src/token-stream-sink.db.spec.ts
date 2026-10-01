// Integration: DrizzleTokenStreamSink against SQLite. Runs only under `pnpm test:db`.
import { SQL_TOKEN_STREAM_SINK_CONTRACT } from '@dudousxd/nestjs-agent-testing';
import Database from 'better-sqlite3';
import { asc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, it } from 'vitest';
import { DrizzleTokenStreamSink } from './drizzle-token-stream-sink.js';
import { ensureAgentSchema } from './ensure-schema.js';
import { agentSchema, agentStreamFrame } from './schema.js';

describe('DrizzleTokenStreamSink — the SQL sink contract', () => {
  for (const contractCase of SQL_TOKEN_STREAM_SINK_CONTRACT) {
    it(contractCase.name, async () => {
      // `:memory:` is per connection, so both "replicas" go through the one database handle.
      const db = drizzle(new Database(':memory:'), { schema: agentSchema });
      await ensureAgentSchema(db);
      await contractCase.run(
        {
          sinkOn: (_replica, options) => new DrizzleTokenStreamSink(db, options),
          rowCount: async (runId) =>
            (await db.select().from(agentStreamFrame).where(eq(agentStreamFrame.runId, runId)))
              .length,
          seqs: async (runId) =>
            (
              await db
                .select({ seq: agentStreamFrame.seq })
                .from(agentStreamFrame)
                .where(eq(agentStreamFrame.runId, runId))
                .orderBy(asc(agentStreamFrame.seq))
            ).map((row) => row.seq),
          insertRow: async (runId, seq, frame, createdAt) => {
            await db.insert(agentStreamFrame).values({ runId, seq, frame, error: null, createdAt });
          },
        },
        `run-${crypto.randomUUID()}`,
      );
    });
  }
});
