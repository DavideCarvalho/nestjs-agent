// Integration: MikroOrmChannelStore on SQLite, Postgres and MySQL. Runs only under `pnpm test:db`.
import { CHANNEL_STORE_CONTRACT } from '@dudousxd/nestjs-agent-testing';
import { afterAll, beforeAll, it } from 'vitest';
import { MikroOrmChannelStore } from './mikro-orm-channel-store';
import { type AgentOrmHandle, describeEachDialect, openAgentOrm, rawSql } from './testing/real-db';

describeEachDialect('MikroOrmChannelStore — the channel store contract', (dialect) => {
  let handle: AgentOrmHandle;

  beforeAll(async () => {
    handle = await openAgentOrm(dialect);
  });

  afterAll(async () => {
    await handle?.close();
  });

  async function fresh() {
    const { orm } = handle;
    await rawSql(orm, 'delete from agent_channel_state');
    return { store: new MikroOrmChannelStore(orm.em) };
  }

  for (const contractCase of CHANNEL_STORE_CONTRACT) {
    it(contractCase.name, async () => contractCase.run(await fresh()));
  }
});
