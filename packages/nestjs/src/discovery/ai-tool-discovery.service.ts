import {
  AGENT_OPTIONS,
  AGENT_TOOL_REGISTRY,
  type ToolHandler,
  type ToolRegistry,
} from '@dudousxd/nestjs-agent-core';
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import type { AgentModuleOptions } from '../agent.options.js';
import { readAiToolMetadata } from '../decorator/ai-tool.decorator.js';

/** Walks every provider at boot and registers `@AiTool` classes into the shared registry. */
@Injectable()
export class AiToolDiscoveryService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AiToolDiscoveryService.name);

  constructor(
    private readonly discovery: DiscoveryService,
    @Inject(AGENT_TOOL_REGISTRY) private readonly registry: ToolRegistry,
    @Inject(AGENT_OPTIONS) private readonly options: AgentModuleOptions,
  ) {}

  onApplicationBootstrap(): void {
    const defaultRoles = this.options.defaultRoles ?? ['ADMIN'];
    let count = 0;
    for (const wrapper of this.discovery.getProviders()) {
      const instance = wrapper.instance;
      if (instance === null || instance === undefined || typeof instance !== 'object') {
        continue;
      }
      const meta = readAiToolMetadata(instance);
      if (meta === undefined) {
        continue;
      }
      const handler = instance as Partial<ToolHandler>;
      if (typeof handler.execute !== 'function') {
        this.logger.warn(`@AiTool "${meta.name}" has no execute() method — skipped`);
        continue;
      }
      this.registry.register(
        {
          name: meta.name,
          kind: meta.kind,
          description: meta.description,
          inputSchema: meta.input,
          roles: meta.roles ?? defaultRoles,
        },
        { execute: (input, ctx) => (instance as ToolHandler).execute(input, ctx) },
      );
      count += 1;
    }
    this.logger.log(`registered ${count} AI tool(s)`);
  }
}
