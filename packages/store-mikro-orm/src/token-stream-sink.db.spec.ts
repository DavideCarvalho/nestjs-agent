// Integration: MikroOrmTokenStreamSink on SQLite, Postgres and MySQL — two "replicas" are two ORMs
// (two pools) over one database wherever the dialect allows it. Runs only under `pnpm test:db`.
import { SQL_TOKEN_STREAM_SINK_CONTRACT } from '@dudousxd/nestjs-agent-testing';
import type { MikroORM } from '@mikro-orm/sqlite';
import { afterAll, beforeAll, beforeEach, it } from 'vitest';
import { MikroOrmTokenStreamSink } from './mikro-orm-token-stream-sink';
import { type AgentOrmHandle, describeEachDialect, openAgentOrm, rawSql } from './testing/real-db';

describeEachDialect('MikroOrmTokenStreamSink — the SQL sink contract', (dialect) => {
  let handle: AgentOrmHandle;
  let replicas: MikroORM[];

  beforeAll(async () => {
    handle = await openAgentOrm(dialect);
    replicas = [handle.orm, await handle.replica()];
  });

  afterAll(async () => {
    await handle?.close();
  });

  // The purge cases count what they purged, so each case starts from an empty table.
  beforeEach(async () => {
    await rawSql(handle.orm, 'delete from agent_stream_frame');
  });

  for (const contractCase of SQL_TOKEN_STREAM_SINK_CONTRACT) {
    it(contractCase.name, async () => {
      const { orm } = handle;
      await contractCase.run(
        {
          sinkOn: (replica, options) =>
            new MikroOrmTokenStreamSink((replicas[replica] ?? orm).em, options),
          rowCount: async (runId) =>
            (
              await rawSql<unknown[]>(orm, 'select seq from agent_stream_frame where run_id = ?', [
                runId,
              ])
            ).length,
          seqs: async (runId) =>
            (
              await rawSql<{ seq: unknown }[]>(
                orm,
                'select seq from agent_stream_frame where run_id = ? order by seq asc',
                [runId],
              )
            ).map((row) => Number(row.seq)),
          insertRow: async (runId, seq, frame, createdAt) => {
            await orm.em
              .fork()
              .getConnection()
              .execute(
                'insert into agent_stream_frame (run_id, seq, frame, error, created_at) values (?, ?, ?, null, ?)',
                [runId, seq, frame, createdAt],
                'run',
              );
          },
        },
        `run-${crypto.randomUUID()}`,
      );
    });
  }
});
