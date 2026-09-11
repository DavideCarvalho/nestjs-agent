import type { DynamicModule, InjectionToken, OptionalFactoryDependency } from '@nestjs/common';
import type { McpServerConfig } from './mcp-options.js';

export interface AgentMcpModuleOptions {
  /** The MCP servers to import tools from. Each is connected once at boot. */
  servers: McpServerConfig[];
}

/**
 * Async variant, for server configuration that only exists at runtime — a URL and a token from
 * config, a command path from the environment.
 */
export interface AgentMcpModuleAsyncOptions {
  imports?: DynamicModule['imports'];
  inject?: Array<InjectionToken | OptionalFactoryDependency>;
  useFactory: (...deps: any[]) => AgentMcpModuleOptions | Promise<AgentMcpModuleOptions>;
}
