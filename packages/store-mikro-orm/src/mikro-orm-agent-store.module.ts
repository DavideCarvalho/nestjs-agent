import {
  AGENT_GOVERNANCE_QUERIES,
  AGENT_PRICING_STORE,
  AGENT_STORE,
} from '@dudousxd/nestjs-agent-core';
import { EntityManager, MikroORM } from '@mikro-orm/core';
import {
  type DynamicModule,
  Module,
  type OnApplicationBootstrap,
  type Provider,
} from '@nestjs/common';
import { ensureAgentSchema } from './ensure-schema';
import { MikroOrmAgentStore } from './mikro-orm-agent-store';
import { MikroOrmGovernanceQueries } from './mikro-orm-governance-queries';
import { MikroOrmPricingStore } from './mikro-orm-pricing-store';

export interface MikroOrmAgentStoreOptions {
  /**
   * Reconcile the agent tables at boot via the fingerprint-gated {@link ensureAgentSchema} (default
   * `true`) — the "autoSchema" the store manages itself, like the durable/notifications stores. Set
   * `false` when the host owns these tables through its own migrations instead.
   */
  autoSchema?: boolean;
}

/** Runs {@link ensureAgentSchema} once the app is up. Registered only when `autoSchema` is on. */
class AgentSchemaInitializer implements OnApplicationBootstrap {
  constructor(private readonly orm: MikroORM) {}

  async onApplicationBootstrap(): Promise<void> {
    await ensureAgentSchema(this.orm);
  }
}

/**
 * Registers the MikroORM agent entities and binds {@link MikroOrmAgentStore} to the
 * {@link AGENT_STORE} token consumed by `@dudousxd/nestjs-agent`, plus
 * {@link MikroOrmGovernanceQueries} to {@link AGENT_GOVERNANCE_QUERIES} (the read-model the
 * dashboard/telescope surfaces consume) and {@link MikroOrmPricingStore} to
 * {@link AGENT_PRICING_STORE} (the write side of the same pricing table).
 *
 * The returned module is global, so {@link AGENT_STORE}, {@link AGENT_GOVERNANCE_QUERIES} and
 * {@link AGENT_PRICING_STORE} are visible app-wide — `AgentModule` resolves the store without an
 * explicit `store` option, and the dashboard/telescope resolve {@link AGENT_GOVERNANCE_QUERIES} /
 * {@link AGENT_PRICING_STORE} without the host re-binding them.
 *
 * By default the store reconciles its tables at boot (fingerprint-gated {@link ensureAgentSchema});
 * pass `{ autoSchema: false }` when the host manages them via its own migrations.
 *
 * The host must register the agent entities in its own MikroORM config — same as the durable and
 * notifications stores — so they enter the shared ORM's discovery metadata (which the store repos
 * and the boot autoSchema read):
 *
 * ```ts
 * // mikro-orm config
 * import { agentEntities } from '@dudousxd/nestjs-agent-store-mikro-orm';
 * entities: [ ...yourEntities, ...agentEntities({ collation: 'utf8mb4_unicode_ci' }) ]
 *
 * // app module
 * @Module({ imports: [MikroOrmAgentStoreModule.forFeature()] })
 * export class AppModule {}
 * ```
 */
@Module({})
export class MikroOrmAgentStoreModule {
  static forFeature(options: MikroOrmAgentStoreOptions = {}): DynamicModule {
    const schemaProviders: Provider[] =
      options.autoSchema === false
        ? []
        : [
            {
              provide: AgentSchemaInitializer,
              useFactory: (orm: MikroORM) => new AgentSchemaInitializer(orm),
              inject: [MikroORM],
            },
          ];
    return {
      module: MikroOrmAgentStoreModule,
      global: true,
      providers: [
        ...schemaProviders,
        {
          provide: MikroOrmAgentStore,
          useFactory: (em: EntityManager) => new MikroOrmAgentStore(em),
          inject: [EntityManager],
        },
        { provide: AGENT_STORE, useExisting: MikroOrmAgentStore },
        {
          provide: MikroOrmGovernanceQueries,
          useFactory: (em: EntityManager) => new MikroOrmGovernanceQueries(em),
          inject: [EntityManager],
        },
        { provide: AGENT_GOVERNANCE_QUERIES, useExisting: MikroOrmGovernanceQueries },
        {
          provide: MikroOrmPricingStore,
          useFactory: (em: EntityManager) => new MikroOrmPricingStore(em),
          inject: [EntityManager],
        },
        { provide: AGENT_PRICING_STORE, useExisting: MikroOrmPricingStore },
      ],
      exports: [
        MikroOrmAgentStore,
        AGENT_STORE,
        MikroOrmGovernanceQueries,
        AGENT_GOVERNANCE_QUERIES,
        MikroOrmPricingStore,
        AGENT_PRICING_STORE,
      ],
    };
  }
}
