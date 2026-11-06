import type { Actor, ActorResolver, EmptyRoles } from '@dudousxd/nestjs-agent-core';
import type { DynamicModule, InjectionToken, OptionalFactoryDependency } from '@nestjs/common';
import type { McpModuleOptions } from '@nestjs/mcp';
import type { McpToolContextResolver } from './agent-mcp-server.js';
import type { McpActionPolicy } from './exposed-tools.js';
import type { McpOAuthOptions } from './protected-resource.js';
import type { McpRoutePrincipalFactory } from './routes/mcp-route-dispatcher.js';

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
  /** Route the MCP endpoint mounts at. Defaults to `'mcp'`. */
  path?: string;
  /**
   * `@nestjs/mcp`'s own settings for the server it serves: `title`, `description`, `instructions`,
   * `icons`, `http` (`allowedHosts`, `allowedOrigins`, `responseMode`, …) and `stdio`. Its `auth`
   * is not taken: who calls is {@link auth}'s answer.
   */
  mcp?: Omit<McpModuleOptions, 'name' | 'version' | 'auth'>;
  /**
   * Serve the agent's tools over stdio too (`McpStdioServer` from `@nestjs/mcp`), as this actor:
   * a stdio connection has no request to authenticate, so whoever starts the process is who calls.
   * Omit → a stdio connection is served only the application's own `@Tool()` methods.
   */
  stdio?: { actor: Actor };
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
  /**
   * What an empty roles list means on THIS surface. `'allow'` (default) — whatever the agent's own
   * `RolesPolicy` says, so the MCP caller reaches exactly what a chat would. `'deny'` — a tool whose
   * roles come out empty (declared `[]`, or none declared and no default roles) is neither listed
   * nor callable here, whatever the chat does: for a deployment whose chat is open but whose MCP
   * surface is reached by callers it does not otherwise know. Set `AgentModule`'s own `emptyRoles`
   * to close both.
   */
  emptyRoles?: EmptyRoles;
  /** How `@Mcp()` controller routes behave on this surface. See {@link McpRouteExposureOptions}. */
  routes?: McpRouteExposureOptions;
  /**
   * Ties a call to the conversation it serves, from the request's `_meta` — e.g. an agent engine
   * that knows which turn an OpenCode session is running, so a tool's
   * `ctx.emitUi` reaches that turn's stream. See {@link McpToolContextResolver}.
   */
  context?: McpToolContextResolver;
  /**
   * OAuth protected-resource metadata (RFC 9728) for this endpoint: served at
   * `GET /.well-known/oauth-protected-resource/<path>` and named (`resource_metadata`) in every 401 /
   * 403 challenge, so an OAuth-aware MCP client finds where to log in. Its `authorization_servers`
   * also names the Poppy issuer when one is announced (Poppy §6) — which alone serves the document
   * when this is omitted.
   */
  oauth?: McpOAuthOptions;
  /**
   * The public origin (`https://app.example.com`) of this deployment — the resource URL in the
   * metadata and challenges. Default: the request's own (Express' `req.protocol`, which honours
   * `trust proxy`, and its `Host`).
   */
  baseUrl?: string;
}

/** Settings for the tools derived from `@Mcp()` controller routes. */
export interface McpRouteExposureOptions {
  /**
   * How the MCP actor becomes the principal of the request a route-derived tool call dispatches —
   * what the route's own guards authenticate against.
   *
   * Defaults to `defaultMcpRoutePrincipal`, which puts the resolved `Actor` on `request.user` and
   * carries nothing over from the inbound MCP request. Supply your own where your guards read
   * something else.
   */
  principal?: McpRoutePrincipalFactory;
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
