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
