import { type DynamicModule, Module } from '@nestjs/common';
import type { AgentMcpModuleAsyncOptions, AgentMcpModuleOptions } from './agent-mcp.options.js';
import { McpToolsService } from './mcp-tools.service.js';
import { AGENT_MCP_OPTIONS } from './tokens.js';

/**
 * Imports an external MCP server's tools as nestjs-agent tools.
 *
 * Import it AFTER `AgentModule`, whose (global) `AGENT_TOOL_REGISTRY` this module writes into:
 * NestJS runs `onApplicationBootstrap` in module-registration order, and registering after the
 * app's own `@AiTool` discovery is what lets a name collision be detected rather than silently
 * overwrite an application tool.
 *
 * ```ts
 * imports: [
 *   AgentModule.forRoot({ ... }),
 *   AgentMcpModule.forRoot({
 *     servers: [{ name: 'github', transport: { type: 'stdio', command: 'mcp-github' } }],
 *   }),
 * ]
 * ```
 */
@Module({})
export class AgentMcpModule {
  static forRoot(options: AgentMcpModuleOptions): DynamicModule {
    return {
      module: AgentMcpModule,
      providers: [{ provide: AGENT_MCP_OPTIONS, useValue: options }, McpToolsService],
      exports: [McpToolsService],
    };
  }

  static forRootAsync(options: AgentMcpModuleAsyncOptions): DynamicModule {
    return {
      module: AgentMcpModule,
      imports: [...(options.imports ?? [])],
      providers: [
        {
          provide: AGENT_MCP_OPTIONS,
          useFactory: options.useFactory,
          inject: options.inject ?? [],
        },
        McpToolsService,
      ],
      exports: [McpToolsService],
    };
  }
}
