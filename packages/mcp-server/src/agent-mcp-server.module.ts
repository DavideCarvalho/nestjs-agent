import { CanAnyone, ToolRegistry } from '@dudousxd/nestjs-agent-core';
import { type DynamicModule, Module, type Provider, UseFilters, UseGuards } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { McpModule } from '@nestjs/mcp';
import { AgentMcpAuthGuard } from './agent-mcp-auth.guard.js';
import { AgentMcpServerBinding } from './agent-mcp-server.binding.js';
import type {
  AgentMcpServerModuleAsyncOptions,
  AgentMcpServerModuleOptions,
} from './agent-mcp-server.options.js';
import { McpChallengeFilter } from './mcp-challenge.js';
import { mcpProtectedResourceController } from './protected-resource.js';
import { McpRouteDiscoveryService } from './routes/mcp-route-discovery.service.js';
import { McpRouteDispatcher } from './routes/mcp-route-dispatcher.js';
import {
  AGENT_MCP_ROUTE_TOOLS,
  AGENT_MCP_SERVER_OPTIONS,
  AGENT_MCP_SERVER_PATH,
} from './tokens.js';

/** Route the MCP endpoint mounts at when `path` is omitted. */
const DEFAULT_PATH = 'mcp';

/**
 * Exposes this deployment's tools to an external MCP client, served by NestJS's own `@nestjs/mcp`.
 *
 * `@nestjs/mcp` owns the endpoint: Streamable HTTP, stateless (any replica answers any request),
 * both protocol revisions, and stdio from a standalone context — and whatever `@Tool()`,
 * `@Resource()` and `@Prompt()` methods the application declares are served beside the agent's
 * tools. This module adds what it has no word for: who is calling (the agent's `ActorResolver`,
 * answered 401 with its challenge when nobody), the agent's tools (`@AiTool`s, MCP-imported tools,
 * `@Mcp()` routes) listed to each caller as the agent's roles policy allows, the `action` exposure
 * policy, and the personal-agent scope step-up.
 *
 * Import it after `AgentModule`, whose (global) `AGENT_TOOL_REGISTRY` and `AGENT_ROLES_POLICY` it
 * serves from.
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
    const path = options.path ?? DEFAULT_PATH;
    const shared = optionsModule(
      path,
      { provide: AGENT_MCP_SERVER_OPTIONS, useValue: options },
      [],
    );
    return moduleFor({
      path,
      options: shared,
      mcp: McpModule.forRoot({
        ...options.mcp,
        name: options.name,
        version: options.version,
        ...structure(path, shared, options.decorators),
      }),
    });
  }

  static forRootAsync(options: AgentMcpServerModuleAsyncOptions): DynamicModule {
    const path = options.path ?? DEFAULT_PATH;
    const shared = optionsModule(
      path,
      {
        provide: AGENT_MCP_SERVER_OPTIONS,
        useFactory: options.useFactory,
        inject: options.inject ?? [],
      },
      options.imports ?? [],
    );
    return moduleFor({
      path,
      options: shared,
      mcp: McpModule.forRootAsync({
        // `imports` (the options module, which the factory injects from) comes with the structure.
        inject: [AGENT_MCP_SERVER_OPTIONS],
        useFactory: (resolved: AgentMcpServerModuleOptions) => ({
          ...resolved.mcp,
          name: resolved.name,
          version: resolved.version,
        }),
        ...structure(path, shared, options.decorators),
      }),
    });
  }
}

/** Holds the resolved options and what both the endpoint's guard and the binding read. */
@Module({})
export class AgentMcpServerOptionsModule {}

/**
 * Serves the protected-resource metadata. A module of its own because the document lives at the app
 * root, not under the endpoint's path.
 */
@Module({})
export class AgentMcpProtectedResourceModule {}

/**
 * How `@nestjs/mcp`'s endpoint is mounted: at `path`, open to `@nestjs/authorization`'s global
 * guard (the agent decides who calls), behind the agent's own guard, with the agent's challenge
 * responses. `imports` give that guard what it injects.
 */
function structure(path: string, shared: DynamicModule, decorators: ClassDecorator[] = []) {
  return {
    path,
    decorators: [
      CanAnyone(),
      UseGuards(AgentMcpAuthGuard),
      UseFilters(McpChallengeFilter),
      ...decorators,
    ],
    imports: [shared],
  };
}

function optionsModule(
  path: string,
  provider: Provider,
  imports: NonNullable<DynamicModule['imports']>,
): DynamicModule {
  return {
    module: AgentMcpServerOptionsModule,
    imports,
    providers: [
      provider,
      { provide: AGENT_MCP_SERVER_PATH, useValue: path },
      // The tools `@Mcp()` routes become, served beside the agent's own.
      { provide: AGENT_MCP_ROUTE_TOOLS, useFactory: () => new ToolRegistry() },
    ],
    exports: [AGENT_MCP_SERVER_OPTIONS, AGENT_MCP_SERVER_PATH, AGENT_MCP_ROUTE_TOOLS],
  };
}

/**
 * Both variants: `@nestjs/mcp`'s endpoint, the binding that serves the agent's tools on it, the
 * `@Mcp()` route discovery, and the metadata module beside it. They import the SAME options module
 * object, so Nest instantiates it once — an async factory runs a single time.
 */
function moduleFor(input: {
  path: string;
  options: DynamicModule;
  mcp: DynamicModule;
}): DynamicModule {
  return {
    module: AgentMcpServerModule,
    imports: [
      DiscoveryModule,
      input.options,
      input.mcp,
      {
        module: AgentMcpProtectedResourceModule,
        imports: [input.options],
        controllers: [mcpProtectedResourceController(input.path)],
      },
    ],
    providers: [AgentMcpServerBinding, McpRouteDispatcher, McpRouteDiscoveryService],
  };
}
