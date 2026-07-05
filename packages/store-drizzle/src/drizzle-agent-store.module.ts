import { AGENT_GOVERNANCE_QUERIES, AGENT_STORE } from '@dudousxd/nestjs-agent-core';
import { type DynamicModule, Module } from '@nestjs/common';
import { DrizzleAgentStore } from './drizzle-agent-store.js';
import { DrizzleGovernanceQueries } from './drizzle-governance-queries.js';
import type { AgentDrizzleDb } from './schema.js';

/** Options for {@link DrizzleAgentStoreModule.forRoot}. The app owns and supplies the db handle. */
export interface DrizzleAgentStoreModuleOptions {
  /** A Drizzle SQLite database instance (`drizzle(client, { schema: agentSchema })`). */
  db: AgentDrizzleDb;
}

/**
 * Binds {@link DrizzleAgentStore} to the {@link AGENT_STORE} token consumed by
 * `@dudousxd/nestjs-agent`, plus {@link DrizzleGovernanceQueries} to
 * {@link AGENT_GOVERNANCE_QUERIES} (the read-model the dashboard/telescope surfaces consume). The
 * host app supplies an already-opened Drizzle db — this module never opens a connection itself.
 *
 * ```ts
 * @Module({ imports: [DrizzleAgentStoreModule.forRoot({ db })] })
 * export class AppModule {}
 * ```
 */
@Module({})
export class DrizzleAgentStoreModule {
  static forRoot(options: DrizzleAgentStoreModuleOptions): DynamicModule {
    return {
      module: DrizzleAgentStoreModule,
      providers: [
        { provide: DrizzleAgentStore, useFactory: () => new DrizzleAgentStore(options.db) },
        { provide: AGENT_STORE, useExisting: DrizzleAgentStore },
        {
          provide: DrizzleGovernanceQueries,
          useFactory: () => new DrizzleGovernanceQueries(options.db),
        },
        { provide: AGENT_GOVERNANCE_QUERIES, useExisting: DrizzleGovernanceQueries },
      ],
      exports: [DrizzleAgentStore, AGENT_STORE, DrizzleGovernanceQueries, AGENT_GOVERNANCE_QUERIES],
    };
  }
}
