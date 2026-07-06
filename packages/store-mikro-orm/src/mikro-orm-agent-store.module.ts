import { AGENT_GOVERNANCE_QUERIES, AGENT_STORE } from '@dudousxd/nestjs-agent-core';
import { EntityManager } from '@mikro-orm/core';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { type DynamicModule, Module } from '@nestjs/common';
import { AGENT_ENTITIES } from './entities';
import { MikroOrmAgentStore } from './mikro-orm-agent-store';
import { MikroOrmGovernanceQueries } from './mikro-orm-governance-queries';

/**
 * Registers the MikroORM agent entities and binds {@link MikroOrmAgentStore} to the
 * {@link AGENT_STORE} token consumed by `@dudousxd/nestjs-agent`, plus
 * {@link MikroOrmGovernanceQueries} to {@link AGENT_GOVERNANCE_QUERIES} (the read-model the
 * dashboard/telescope surfaces consume).
 *
 * The returned module is global, so {@link AGENT_STORE} and {@link AGENT_GOVERNANCE_QUERIES} are
 * visible app-wide — `AgentModule` resolves the store without an explicit `store` option, and the
 * dashboard/telescope resolve {@link AGENT_GOVERNANCE_QUERIES} without the host re-binding it.
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
      ],
      exports: [
        MikroOrmAgentStore,
        AGENT_STORE,
        MikroOrmGovernanceQueries,
        AGENT_GOVERNANCE_QUERIES,
      ],
    };
  }
}
