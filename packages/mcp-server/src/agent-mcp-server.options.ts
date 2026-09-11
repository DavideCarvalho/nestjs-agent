import type { ActorResolver } from '@dudousxd/nestjs-agent-core';
import type { DynamicModule, InjectionToken, OptionalFactoryDependency } from '@nestjs/common';
import type { McpActionPolicy } from './exposed-tools.js';

export interface AgentMcpServerModuleOptions {
  /** Server name reported to MCP clients in the initialize handshake. */
  name: string;
  /** Server version reported to MCP clients. */
  version: string;
  /**
   * Who is calling. REQUIRED, with no default and no fallback identity: this decides which of your
   * tools a program you did not write gets to run, so it is a compile-time obligation rather than
   * something that can be left off.
   *
   * It is the same {@link ActorResolver} seam `AgentModule.forRoot({ actorResolver })` takes — pass
   * that same resolver to give MCP callers exactly the identities your app already knows, or a
   * machine-to-machine one such as `BearerTokenActorResolver`. It MUST reject an unidentified
   * caller by throwing (an `UnauthorizedException`, so the caller reads 401); returning an actor
   * with no roles is what "authenticated, but entitled to nothing" looks like.
   */
  auth: ActorResolver;
  /** Route the MCP endpoint mounts at. Defaults to `'mcp'` (→ `POST|GET|DELETE /mcp`). */
  path?: string;
  /**
   * What an `action` tool means on a surface with no human attached. Defaults to `'deny'` — they
   * are neither listed nor callable. See {@link McpActionPolicy} before widening it.
   */
  actions?: McpActionPolicy;
  /**
   * The tool names this deployment exposes over MCP. Omit → every tool of an exposable kind that
   * the calling actor's roles already allow. Enforced on `tools/call` as well as `tools/list`, so a
   * name left off is unreachable rather than merely unadvertised.
   */
  allowedTools?: string[];
}

/** Async variant, for auth that only exists at runtime — a key list from config, a JWT verifier. */
export interface AgentMcpServerModuleAsyncOptions {
  imports?: DynamicModule['imports'];
  inject?: Array<InjectionToken | OptionalFactoryDependency>;
  useFactory: (
    ...deps: never[]
  ) => AgentMcpServerModuleOptions | Promise<AgentMcpServerModuleOptions>;
  /**
   * Route the MCP endpoint mounts at. Static routing metadata, so it lives here rather than in the
   * async factory result — which resolves after the routes are mounted.
   */
  path?: string;
}
