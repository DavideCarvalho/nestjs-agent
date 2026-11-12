import {
  AGENT_CHANNEL_STORE,
  AGENT_CONFIRM_TOKEN_STORE,
  AGENT_GOVERNANCE_QUERIES,
  AGENT_POPPY_CONNECTION_STORE,
  AGENT_POPPY_STORE,
  AGENT_PRICING_STORE,
  AGENT_STORE,
  type AgentPricingStore,
} from '@dudousxd/nestjs-agent-core';
import { type DynamicModule, Module, type Provider, type Type } from '@nestjs/common';
import { agentDialectOf, assertAgentSchema } from './dialect.js';
import { DrizzleAgentStore } from './drizzle-agent-store.js';
import { DrizzleChannelStore } from './drizzle-channel-store.js';
import { DrizzleConfirmTokenStore } from './drizzle-confirm-token-store.js';
import { DrizzleGovernanceQueries } from './drizzle-governance-queries.js';
import { DrizzleMemoryProvider } from './drizzle-memory-provider.js';
import { DrizzlePoppyConnectionStore } from './drizzle-poppy-connection-store.js';
import { DrizzlePoppyStore } from './drizzle-poppy-store.js';
import { DrizzlePricingStore } from './drizzle-pricing-store.js';
import { DrizzleRagIngestionLog } from './drizzle-rag-ingestion-log.js';
import type { AgentDrizzleDb } from './schema.js';

/** Options for {@link DrizzleAgentStoreModule.forRoot}. The app owns and supplies the db handle. */
export interface DrizzleAgentStoreModuleOptions {
  /**
   * A Drizzle database on SQLite, Postgres or MySQL — `drizzle(client, { schema: agentSchema })`,
   * `pgAgentSchema` or `mysqlAgentSchema`. The stores read the dialect off the handle.
   */
  db: AgentDrizzleDb;
  /**
   * Bind {@link AGENT_PRICING_STORE} (which {@link DrizzleGovernanceQueries} prices usage against) to
   * a host-supplied store instead of the default {@link DrizzlePricingStore} — make your OWN pricing
   * table the single source of cost truth without touching `agent_model_pricing`.
   */
  pricingStore?: Type<AgentPricingStore>;
  /**
   * Record every RAG ingestion outcome into `rag_ingestion_log` by subscribing to the `aviary:rag:*`
   * diagnostics channels (default `true`, matching the MikroORM adapter). This is the only place a
   * *failed* or *skipped* document is visible — one that produced no chunks doesn't exist as far as
   * `VectorStore.listDocuments()` is concerned. Set `false` if you don't ingest media into RAG, or
   * record outcomes yourself.
   *
   * The table has to exist: `ensureAgentSchema` creates it, or write the `CREATE TABLE` into
   * your own migrations. Writes are best-effort, so a missing table costs a warning per ingestion
   * rather than a failed ingestion.
   */
  ragIngestionLog?: boolean;
  /**
   * The Postgres schema (or MySQL database) the agent tables live in; every statement the stores
   * issue names it, and `ensureAgentSchema(db, { schema })` creates it. Never set through the
   * connection's `search_path`. Omit → the connection's current schema. Not supported on SQLite.
   */
  schema?: string;
}

/**
 * Binds {@link DrizzleAgentStore} to the {@link AGENT_STORE} token consumed by
 * `@dudousxd/nestjs-agent`, plus {@link DrizzleGovernanceQueries} to
 * {@link AGENT_GOVERNANCE_QUERIES} (the read-model the dashboard/telescope surfaces consume) and
 * {@link DrizzlePricingStore} to {@link AGENT_PRICING_STORE} (the write side of that pricing table),
 * {@link DrizzleConfirmTokenStore} to {@link AGENT_CONFIRM_TOKEN_STORE} (confirmed writes), and
 * {@link DrizzleChannelStore} to {@link AGENT_CHANNEL_STORE} (text channels' state), and
 * {@link DrizzlePoppyStore} / {@link DrizzlePoppyConnectionStore} to {@link AGENT_POPPY_STORE} /
 * {@link AGENT_POPPY_CONNECTION_STORE} (Personal Agent Protocol conversations and connections).
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
    // Validated here, so a bad name or a schema on SQLite fails the boot rather than the first query.
    assertAgentSchema(agentDialectOf(options.db), options.schema);
    const at = options.schema !== undefined ? { schema: options.schema } : {};
    const ragProviders: Provider[] =
      options.ragIngestionLog === false
        ? []
        : [
            {
              provide: DrizzleRagIngestionLog,
              useFactory: () => new DrizzleRagIngestionLog(options.db, at),
            },
          ];
    return {
      module: DrizzleAgentStoreModule,
      global: true,
      providers: [
        ...ragProviders,
        { provide: DrizzleAgentStore, useFactory: () => new DrizzleAgentStore(options.db, at) },
        { provide: AGENT_STORE, useExisting: DrizzleAgentStore },
        // Exported, never bound to AGENT_MEMORY: that token's PRESENCE is what turns memory on, so
        // binding it here would switch the feature on for every host that installs the store. A
        // host opts in by naming this provider in `AgentModule.forRoot({ memory: { provider } })`.
        {
          provide: DrizzleMemoryProvider,
          useFactory: () => new DrizzleMemoryProvider(options.db, at),
        },
        {
          provide: DrizzlePricingStore,
          useFactory: () => new DrizzlePricingStore(options.db, at),
        },
        // AGENT_PRICING_STORE: the host's own store when supplied, else the default Drizzle one.
        // DrizzleGovernanceQueries prices usage against whatever is bound here.
        options.pricingStore
          ? { provide: AGENT_PRICING_STORE, useClass: options.pricingStore }
          : { provide: AGENT_PRICING_STORE, useExisting: DrizzlePricingStore },
        {
          provide: DrizzleGovernanceQueries,
          useFactory: (pricingStore: AgentPricingStore) =>
            new DrizzleGovernanceQueries(options.db, pricingStore, undefined, at),
          inject: [AGENT_PRICING_STORE],
        },
        { provide: AGENT_GOVERNANCE_QUERIES, useExisting: DrizzleGovernanceQueries },
        // What makes a `defineConfirmedTool` confirmation single use across replicas.
        {
          provide: DrizzleConfirmTokenStore,
          useFactory: () => new DrizzleConfirmTokenStore(options.db, at),
        },
        { provide: AGENT_CONFIRM_TOKEN_STORE, useExisting: DrizzleConfirmTokenStore },
        // Text channels' state (`@dudousxd/nestjs-agent-channels`), shared by every replica.
        { provide: DrizzleChannelStore, useFactory: () => new DrizzleChannelStore(options.db, at) },
        { provide: AGENT_CHANNEL_STORE, useExisting: DrizzleChannelStore },
        // Personal Agent Protocol (Poppy) conversations and connections, shared by every replica.
        { provide: DrizzlePoppyStore, useFactory: () => new DrizzlePoppyStore(options.db, at) },
        { provide: AGENT_POPPY_STORE, useExisting: DrizzlePoppyStore },
        {
          provide: DrizzlePoppyConnectionStore,
          useFactory: () => new DrizzlePoppyConnectionStore(options.db, at),
        },
        { provide: AGENT_POPPY_CONNECTION_STORE, useExisting: DrizzlePoppyConnectionStore },
      ],
      exports: [
        ...(options.ragIngestionLog === false ? [] : [DrizzleRagIngestionLog]),
        DrizzleAgentStore,
        AGENT_STORE,
        DrizzleMemoryProvider,
        DrizzleGovernanceQueries,
        AGENT_GOVERNANCE_QUERIES,
        DrizzlePricingStore,
        AGENT_PRICING_STORE,
        DrizzleConfirmTokenStore,
        AGENT_CONFIRM_TOKEN_STORE,
        DrizzleChannelStore,
        AGENT_CHANNEL_STORE,
        DrizzlePoppyStore,
        AGENT_POPPY_STORE,
        DrizzlePoppyConnectionStore,
        AGENT_POPPY_CONNECTION_STORE,
      ],
    };
  }
}
