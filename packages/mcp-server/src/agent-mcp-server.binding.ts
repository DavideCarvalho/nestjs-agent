import {
  AGENT_ROLES_POLICY,
  AGENT_TOOL_REGISTRY,
  type Actor,
  type RolesPolicy,
  type ToolRegistry,
  closeEmptyRoles,
  personalAgentGate,
} from '@dudousxd/nestjs-agent-core';
import type { McpServer } from '@modelcontextprotocol/server';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import { mcpActorOf } from './agent-mcp-auth.guard.js';
import { registerAgentTools } from './agent-mcp-server.js';
import type { AgentMcpServerModuleOptions } from './agent-mcp-server.options.js';
import { AGENT_MCP_ROUTE_TOOLS, AGENT_MCP_SERVER_OPTIONS } from './tokens.js';

const logger = new Logger('AgentMcpServer');

/** What `@nestjs/mcp`'s `McpServerFactory.create()` is handed for one server: one HTTP request, or a stdio connection. */
interface McpServing {
  transport: 'http' | 'stdio';
  request?: unknown;
}

/**
 * `@nestjs/mcp`'s `McpServerFactory`, as far as this binding relies on it. Its own `create()` is
 * synchronous; the wrapped one returns a promise when it registers the agent's tools, which every
 * caller in `@nestjs/mcp` 0.0.4 awaits (the HTTP handler and stdio's `serveStdio` both take an
 * SDK `McpServerFactory`, typed `McpServer | Promise<McpServer>`). Typed as such, so a caller that
 * would use the result synchronously does not compile.
 */
interface McpServerFactoryLike {
  create(serving: McpServing): McpServer | Promise<McpServer>;
}

/** Marks a factory this binding already wrapped, so a second registration does not wrap it twice. */
const WRAPPED = Symbol.for('@dudousxd/nestjs-agent-mcp-server:wrapped');

/**
 * Serves the agent's tools from `@nestjs/mcp`'s server — and only those the caller may use.
 *
 * `@nestjs/mcp` builds one SDK server per HTTP request (stateless) and registers on it every
 * `@Tool()` of the application. It has no way to register tools that are not decorated methods, and
 * no way to list a tool to one caller and not another: a tool's `scopes` are only checked when it is
 * called. The agent's tools are neither (an MCP-imported tool, a `@Mcp()` route, generative UI…),
 * and an agent tool the caller's roles do not reach must not even be listed. So this binding wraps
 * that factory: once it has built a request's server, the agent's tools the request's actor may
 * use are registered on it, through the SDK's public `registerTool`.
 *
 * `McpServerFactory` is not part of `@nestjs/mcp`'s public API, which is why the dependency is pinned
 * to the versions this was checked against, and why a test fails if the factory stops being found.
 * Until `@nestjs/mcp` grows a hook for it (asked upstream), this is the one place that reaches in.
 */
@Injectable()
export class AgentMcpServerBinding implements OnModuleInit {
  private readonly policy: RolesPolicy;

  constructor(
    private readonly modules: ModulesContainer,
    @Inject(AGENT_MCP_SERVER_OPTIONS) private readonly options: AgentMcpServerModuleOptions,
    @Inject(AGENT_TOOL_REGISTRY) private readonly registry: ToolRegistry,
    @Inject(AGENT_ROLES_POLICY) policy: RolesPolicy,
    @Inject(AGENT_MCP_ROUTE_TOOLS) private readonly routeTools: ToolRegistry,
  ) {
    this.policy = personalAgentGate(
      options.emptyRoles === 'deny' ? closeEmptyRoles(policy) : policy,
    );
  }

  onModuleInit(): void {
    const factory = findMcpServerFactory(this.modules);
    if (factory === undefined) {
      throw new Error(
        "AgentMcpServerModule: @nestjs/mcp's McpServerFactory was not found, so the agent's tools " +
          'cannot be served. This @nestjs/mcp version is not one this package supports.',
      );
    }
    const target = factory as McpServerFactoryLike & { [WRAPPED]?: true };
    if (target[WRAPPED] === true) return;
    const create = target.create.bind(target);
    // Async only where it has to be: both `@nestjs/mcp` callers (HTTP and stdio) await the factory,
    // and a server built for no agent actor is `@nestjs/mcp`'s, returned as it was.
    target.create = (serving: McpServing): McpServer | Promise<McpServer> => {
      const server = create(serving);
      const actor = this.actorFor(serving);
      if (actor === undefined) return server;
      return this.serve(server, actor);
    };
    target[WRAPPED] = true;
  }

  /** Who a server is built for: the request the guard authenticated, or the configured stdio actor. */
  private actorFor(serving: McpServing): Actor | undefined {
    if (serving.transport === 'http') return mcpActorOf(serving.request);
    return this.options.stdio?.actor;
  }

  private async serve(built: McpServer | Promise<McpServer>, actor: Actor): Promise<McpServer> {
    const server = await built;
    await registerAgentTools(server, {
      actor,
      registry: this.registry,
      routeTools: this.routeTools,
      policy: this.policy,
      ...(this.options.actions !== undefined ? { actions: this.options.actions } : {}),
      ...(this.options.allowedTools !== undefined
        ? { allowedTools: this.options.allowedTools }
        : {}),
      ...(this.options.context !== undefined ? { context: this.options.context } : {}),
      onSkipped: (name, reason) =>
        logger.warn(`Agent tool "${name}" is not served over MCP: ${reason}`),
    });
    return server;
  }
}

/** `@nestjs/mcp`'s `McpServerFactory` instance, found among the application's providers. */
export function findMcpServerFactory(modules: ModulesContainer): McpServerFactoryLike | undefined {
  for (const module of modules.values()) {
    for (const wrapper of module.providers.values()) {
      const instance = wrapper.instance as { create?: unknown } | null | undefined;
      if (
        wrapper.metatype?.name === 'McpServerFactory' &&
        instance !== null &&
        instance !== undefined &&
        typeof instance.create === 'function'
      ) {
        return instance as McpServerFactoryLike;
      }
    }
  }
  return undefined;
}
