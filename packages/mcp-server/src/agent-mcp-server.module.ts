import { ToolRegistry } from '@dudousxd/nestjs-agent-core';
import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { DiscoveryModule, RouterModule } from '@nestjs/core';
import { AgentMcpServerController } from './agent-mcp-server.controller.js';
import type {
  AgentMcpServerModuleAsyncOptions,
  AgentMcpServerModuleOptions,
} from './agent-mcp-server.options.js';
import { McpSessionStore } from './mcp-sessions.js';
import { McpRouteDiscoveryService } from './routes/mcp-route-discovery.service.js';
import { McpRouteDispatcher } from './routes/mcp-route-dispatcher.js';
import { AGENT_MCP_ROUTE_TOOLS, AGENT_MCP_SERVER_OPTIONS } from './tokens.js';

/** Route the MCP endpoint mounts at when `path` is omitted. */
const DEFAULT_PATH = 'mcp';

/**
 * Exposes this deployment's tools to an external MCP client over Streamable HTTP.
 *
 * The opposite direction to `@dudousxd/nestjs-agent-mcp`, which IMPORTS a remote server's tools.
 * Import it after `AgentModule`, whose (global) `AGENT_TOOL_REGISTRY` and `AGENT_ROLES_POLICY` it
 * serves from: the tools an MCP caller reaches are the tools the agent loop runs, gated by the same
 * policy, and never a second list that has to be kept in step.
 *
 * ```ts
 * imports: [
 *   AgentModule.forRoot({ ... }),
 *   AgentMcpServerModule.forRoot({
 *     name: 'Acme Agent',
 *     version: '1.0.0',
 *     auth: new BearerTokenActorResolver([{ token: process.env.MCP_TOKEN, actor: { id: 'ci', roles: ['ANALYST'] } }]),
 *   }),
 * ]
 * ```
 */
@Module({})
export class AgentMcpServerModule {
  static forRoot(options: AgentMcpServerModuleOptions): DynamicModule {
    return {
      module: AgentMcpServerModule,
      imports: [DiscoveryModule, routerFor(options.path ?? DEFAULT_PATH)],
      controllers: [AgentMcpServerController],
      providers: [{ provide: AGENT_MCP_SERVER_OPTIONS, useValue: options }, ...ROUTE_PROVIDERS],
      exports: [McpSessionStore],
    };
  }

  static forRootAsync(options: AgentMcpServerModuleAsyncOptions): DynamicModule {
    return {
      module: AgentMcpServerModule,
      imports: [
        DiscoveryModule,
        routerFor(options.path ?? DEFAULT_PATH),
        ...(options.imports ?? []),
      ],
      controllers: [AgentMcpServerController],
      providers: [
        {
          provide: AGENT_MCP_SERVER_OPTIONS,
          useFactory: options.useFactory,
          inject: options.inject ?? [],
        },
        ...ROUTE_PROVIDERS,
      ],
      exports: [McpSessionStore],
    };
  }
}

/**
 * Everything both variants provide: the live sessions, the registry `@Mcp()` routes land in, the
 * dispatcher that runs one through its request pipeline, and the boot walk that finds them.
 */
const ROUTE_PROVIDERS: Provider[] = [
  McpSessionStore,
  { provide: AGENT_MCP_ROUTE_TOOLS, useFactory: () => new ToolRegistry() },
  McpRouteDispatcher,
  McpRouteDiscoveryService,
];

/** Mount the controller under `path` (Nest applies the prefix to its relative routes). */
function routerFor(path: string): DynamicModule {
  return RouterModule.register([{ path, module: AgentMcpServerModule }]);
}
