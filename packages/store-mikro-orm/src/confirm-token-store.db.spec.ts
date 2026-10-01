// Integration: MikroOrmConfirmTokenStore on SQLite, Postgres and MySQL. Runs only under `pnpm test:db`.
import { CONFIRM_TOKEN_STORE_CONTRACT } from '@dudousxd/nestjs-agent-testing';
import { afterAll, beforeAll, it } from 'vitest';
import { MikroOrmConfirmTokenStore } from './mikro-orm-confirm-token-store';
import { type AgentOrmHandle, describeEachDialect, openAgentOrm, rawSql } from './testing/real-db';

describeEachDialect('MikroOrmConfirmTokenStore — the confirm-token store contract', (dialect) => {
  let handle: AgentOrmHandle;

  beforeAll(async () => {
    handle = await openAgentOrm(dialect);
  });

  afterAll(async () => {
    await handle?.close();
  });

  async function fresh() {
    const { orm } = handle;
    await rawSql(orm, 'delete from agent_confirm_token');
    return {
      store: new MikroOrmConfirmTokenStore(orm.em),
      rows: () => rawSql<Record<string, unknown>[]>(orm, 'select * from agent_confirm_token'),
    };
  }

  for (const contractCase of CONFIRM_TOKEN_STORE_CONTRACT) {
    it(contractCase.name, async () => contractCase.run(await fresh()));
  }
});
