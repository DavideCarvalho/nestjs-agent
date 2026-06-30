import { AGENT_STORE } from '@dudousxd/nestjs-agent-core';
import { EntityManager } from '@mikro-orm/core';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { type DynamicModule, Module } from '@nestjs/common';
import { AGENT_ENTITIES } from './entities';
import { MikroOrmAgentStore } from './mikro-orm-agent-store';

/**
 * Registers the MikroORM agent entities and binds {@link MikroOrmAgentStore} to the
 * {@link AGENT_STORE} token consumed by `@dudousxd/nestjs-agent`.
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
      ],
      exports: [MikroOrmAgentStore, AGENT_STORE],
    };
  }
}
