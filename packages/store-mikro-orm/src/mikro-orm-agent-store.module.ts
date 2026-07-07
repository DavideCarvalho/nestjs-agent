import {
  AGENT_GOVERNANCE_QUERIES,
  AGENT_PRICING_STORE,
  AGENT_STORE,
} from '@dudousxd/nestjs-agent-core';
import { EntityManager } from '@mikro-orm/core';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { type DynamicModule, Module } from '@nestjs/common';
import { AGENT_ENTITIES } from './entities';
import { MikroOrmAgentStore } from './mikro-orm-agent-store';
import { MikroOrmGovernanceQueries } from './mikro-orm-governance-queries';
import { MikroOrmPricingStore } from './mikro-orm-pricing-store';

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
 * ```ts
 * @Module({ imports: [MikroOrmAgentStoreModule.forFeature()] })
 * export class AppModule {}
 * ```
 */
@Module({})
export class MikroOrmAgentStoreModule {
  static forFeature(): DynamicModule {
    return {
      module: MikroOrmAgentStoreModule,
      global: true,
      imports: [MikroOrmModule.forFeature(AGENT_ENTITIES)],
      providers: [
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
