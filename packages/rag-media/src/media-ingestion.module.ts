import { type DynamicModule, Module } from '@nestjs/common';
import {
  type AgentMediaIngestionOptions,
  AgentMediaIngestionService,
} from './agent-media-ingestion.service.js';

/**
 * Wires media → RAG ingestion into a NestJS app. `forRoot` registers (and exports) the
 * {@link AgentMediaIngestionService}, which subscribes to the media diagnostics channels on boot.
 *
 * ```ts
 * AgentMediaIngestionModule.forRoot({
 *   store,
 *   embedder,
 *   collections: ['knowledge-base'],
 *   readFile: (disk, path) => media.disk(disk).get(path),
 * });
 * ```
 */
@Module({})
export class AgentMediaIngestionModule {
  static forRoot(options: AgentMediaIngestionOptions): DynamicModule {
    return {
      module: AgentMediaIngestionModule,
      providers: [
        {
          provide: AgentMediaIngestionService,
          useFactory: () => new AgentMediaIngestionService(options),
        },
      ],
      exports: [AgentMediaIngestionService],
    };
  }
}
