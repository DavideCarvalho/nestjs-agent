// Integration: MikroOrmTokenStreamSink against SQLite. Runs only under `pnpm test:db`.
import { SQL_TOKEN_STREAM_SINK_CONTRACT } from '@dudousxd/nestjs-agent-testing';
import { MikroORM, SqliteDriver } from '@mikro-orm/sqlite';
import { afterEach, describe, it } from 'vitest';
import { ensureAgentSchema } from './ensure-schema';
import { agentEntities } from './entities';
import { MikroOrmTokenStreamSink } from './mikro-orm-token-stream-sink';

let orm: MikroORM | undefined;

afterEach(async () => {
  await orm?.close(true);
  orm = undefined;
});

describe('MikroOrmTokenStreamSink — the SQL sink contract', () => {
  for (const contractCase of SQL_TOKEN_STREAM_SINK_CONTRACT) {
    it(contractCase.name, async () => {
      orm = await MikroORM.init({
        driver: SqliteDriver,
        dbName: ':memory:',
        entities: agentEntities(),
        allowGlobalContext: true,
      });
      await ensureAgentSchema(orm);
      const { em } = orm;
      const connection = em.getConnection();
      await contractCase.run(
        {
          sinkOn: (_replica, options) => new MikroOrmTokenStreamSink(em, options),
          rowCount: async (runId) =>
            (
              await connection.execute('select seq from agent_stream_frame where run_id = ?', [
                runId,
              ])
            ).length,
          seqs: async (runId) =>
            (
              await connection.execute<{ seq: number }[]>(
                'select seq from agent_stream_frame where run_id = ? order by seq asc',
                [runId],
              )
            ).map((row) => Number(row.seq)),
          insertRow: async (runId, seq, frame, createdAt) => {
            await connection.execute(
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
