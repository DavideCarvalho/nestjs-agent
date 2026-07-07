import {
  AGENT_GOVERNANCE_QUERIES,
  AGENT_PRICING_STORE,
  AGENT_STORE,
} from '@dudousxd/nestjs-agent-core';
import { type DynamicModule, Module } from '@nestjs/common';
import { DrizzleAgentStore } from './drizzle-agent-store.js';
import { DrizzleGovernanceQueries } from './drizzle-governance-queries.js';
import { DrizzlePricingStore } from './drizzle-pricing-store.js';
import type { AgentDrizzleDb } from './schema.js';

/** Options for {@link DrizzleAgentStoreModule.forRoot}. The app owns and supplies the db handle. */
export interface DrizzleAgentStoreModuleOptions {
  /** A Drizzle SQLite database instance (`drizzle(client, { schema: agentSchema })`). */
  db: AgentDrizzleDb;
}

/**
 * Binds {@link DrizzleAgentStore} to the {@link AGENT_STORE} token consumed by
 * `@dudousxd/nestjs-agent`, plus {@link DrizzleGovernanceQueries} to
 * {@link AGENT_GOVERNANCE_QUERIES} (the read-model the dashboard/telescope surfaces consume) and
 * {@link DrizzlePricingStore} to {@link AGENT_PRICING_STORE} (the write side of that pricing table).
 * The host app supplies an already-opened Drizzle db — this module never opens a connection itself.
 *
 * The returned module is global, so {@link AGENT_STORE}, {@link AGENT_GOVERNANCE_QUERIES} and
 * {@link AGENT_PRICING_STORE} are visible app-wide — `AgentModule` resolves the store without an
 * explicit `store` option, and the dashboard/telescope resolve {@link AGENT_GOVERNANCE_QUERIES}
 * without the host re-binding it.
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
      global: true,
      providers: [
        { provide: DrizzleAgentStore, useFactory: () => new DrizzleAgentStore(options.db) },
        { provide: AGENT_STORE, useExisting: DrizzleAgentStore },
        {
          provide: DrizzleGovernanceQueries,
          useFactory: () => new DrizzleGovernanceQueries(options.db),
        },
        { provide: AGENT_GOVERNANCE_QUERIES, useExisting: DrizzleGovernanceQueries },
        {
          provide: DrizzlePricingStore,
          useFactory: () => new DrizzlePricingStore(options.db),
        },
        { provide: AGENT_PRICING_STORE, useExisting: DrizzlePricingStore },
      ],
      exports: [
        DrizzleAgentStore,
        AGENT_STORE,
        DrizzleGovernanceQueries,
        AGENT_GOVERNANCE_QUERIES,
        DrizzlePricingStore,
        AGENT_PRICING_STORE,
      ],
    };
  }
}
