// Starts ONE Postgres and ONE MySQL container for the whole `pnpm test:db` run and hands their
// connection URLs to every spec through `inject('realDb')`. Each spec file then creates its own
// throwaway database inside them (see `packages/*/src/testing/real-db.ts`), so files stay isolated
// while the run pays the container start once per dialect, not once per file.
//
// No Docker: the real-database suites skip with a message saying so, and SQLite still runs — unless
// `CI` or `AGENT_TEST_REQUIRE_REAL_DB` is set, where a missing Docker is a failure, not a skip.
// `AGENT_TEST_PG_URL` / `AGENT_TEST_MYSQL_URL` point the suites at a server you already run instead.
import { MySqlContainer, type StartedMySqlContainer } from '@testcontainers/mysql';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { getContainerRuntimeClient } from 'testcontainers';
import type { GlobalSetupContext } from 'vitest/node';

export interface RealDbUrls {
  /** Admin URL of a Postgres server whose user may `CREATE DATABASE`; absent → those suites skip. */
  postgres?: string;
  /** Admin URL of a MySQL server whose user may `CREATE DATABASE`; absent → those suites skip. */
  mysql?: string;
  /** Why a dialect is absent, printed by the suites that skip. */
  skipReason?: string;
}

declare module 'vitest' {
  export interface ProvidedContext {
    realDb: RealDbUrls;
  }
}

/** The images the matrix runs against. Postgres carries pgvector so a vector-backed store can share it. */
const POSTGRES_IMAGE = 'pgvector/pgvector:pg16';
const MYSQL_IMAGE = 'mysql:8.4';

const required = (): boolean =>
  Boolean(process.env.CI) || Boolean(process.env.AGENT_TEST_REQUIRE_REAL_DB);

async function dockerAvailable(): Promise<string | undefined> {
  try {
    await getContainerRuntimeClient();
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export default async function setup({ provide }: GlobalSetupContext) {
  const urls: RealDbUrls = {
    ...(process.env.AGENT_TEST_PG_URL ? { postgres: process.env.AGENT_TEST_PG_URL } : {}),
    ...(process.env.AGENT_TEST_MYSQL_URL ? { mysql: process.env.AGENT_TEST_MYSQL_URL } : {}),
  };
  const started: Array<StartedPostgreSqlContainer | StartedMySqlContainer> = [];

  if (urls.postgres === undefined || urls.mysql === undefined) {
    const noDocker = await dockerAvailable();
    if (noDocker !== undefined) {
      const cause = `Docker is not available (${noDocker.split('\n')[0]})`;
      if (required()) {
        throw new Error(
          `[test:db] ${cause}. The Postgres and MySQL suites are required here (CI / AGENT_TEST_REQUIRE_REAL_DB), so this run fails rather than skipping them.`,
        );
      }
      const reason = `${cause}, so the Postgres/MySQL suites are skipped and only SQLite runs. Start Docker, or set AGENT_TEST_PG_URL / AGENT_TEST_MYSQL_URL.`;
      console.warn(`\n[test:db] ${reason}\n`);
      urls.skipReason = reason;
    } else {
      // Both at once: MySQL's first boot is the slow one, so it overlaps Postgres's.
      const [postgres, mysql] = await Promise.all([
        urls.postgres === undefined
          ? new PostgreSqlContainer(POSTGRES_IMAGE)
              .withLabels({ 'nestjs-agent.test-db': 'postgres' })
              // Each spec file opens a few pools against its own database; the default 100 is tight
              // once every worker runs a file at the same time.
              .withCommand(['postgres', '-c', 'max_connections=500', '-c', 'fsync=off'])
              .start()
          : undefined,
        urls.mysql === undefined
          ? new MySqlContainer(MYSQL_IMAGE)
              .withLabels({ 'nestjs-agent.test-db': 'mysql' })
              .withRootPassword('test')
              .withCommand([
                '--max-connections=500',
                '--innodb-flush-log-at-trx-commit=0',
                '--skip-log-bin',
              ])
              .start()
          : undefined,
      ]);
      if (postgres !== undefined) {
        started.push(postgres);
        urls.postgres = postgres.getConnectionUri();
      }
      if (mysql !== undefined) {
        started.push(mysql);
        urls.mysql = `mysql://root:test@${mysql.getHost()}:${mysql.getPort()}/mysql`;
      }
    }
  }

  provide('realDb', urls);

  return async () => {
    await Promise.all(started.map((container) => container.stop()));
  };
}
