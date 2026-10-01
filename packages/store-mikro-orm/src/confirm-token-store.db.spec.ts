// Integration: MikroOrmConfirmTokenStore against an in-memory SQLite. Runs only under `pnpm test:db`.
import { CONFIRM_TOKEN_STORE_CONTRACT } from '@dudousxd/nestjs-agent-testing';
import { MikroORM, SqliteDriver } from '@mikro-orm/sqlite';
import { afterEach, describe, it } from 'vitest';
import { ensureAgentSchema } from './ensure-schema';
import { agentEntities } from './entities';
import { MikroOrmConfirmTokenStore } from './mikro-orm-confirm-token-store';

let orm: MikroORM | undefined;

afterEach(async () => {
  await orm?.close(true);
  orm = undefined;
});

async function fresh() {
  orm = await MikroORM.init({
    driver: SqliteDriver,
    dbName: ':memory:',
    entities: agentEntities(),
    allowGlobalContext: true,
  });
  await ensureAgentSchema(orm);
  const connection = orm.em.getConnection();
  return {
    store: new MikroOrmConfirmTokenStore(orm.em),
    rows: () => connection.execute<Record<string, unknown>[]>('select * from agent_confirm_token'),
  };
}

describe('MikroOrmConfirmTokenStore — the confirm-token store contract', () => {
  for (const contractCase of CONFIRM_TOKEN_STORE_CONTRACT) {
    it(contractCase.name, async () => contractCase.run(await fresh()));
  }
});
