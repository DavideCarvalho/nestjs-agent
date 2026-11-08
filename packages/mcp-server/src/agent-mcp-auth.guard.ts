import type { IncomingMessage } from 'node:http';
import {
  AGENT_ROLES_POLICY,
  AGENT_TOOL_REGISTRY,
  type Actor,
  type RolesPolicy,
  type ToolRegistry,
  closeEmptyRoles,
  missingScopes,
  personalAgentGate,
} from '@dudousxd/nestjs-agent-core';
import {
  type CanActivate,
  type ExecutionContext,
  HttpException,
  Inject,
  Injectable,
} from '@nestjs/common';
import type { AgentMcpServerModuleOptions } from './agent-mcp-server.options.js';
import { authenticateMcpRequest } from './authenticate.js';
import { mcpExposureRefusal } from './exposed-tools.js';
import { McpChallengeException } from './mcp-challenge.js';
import {
  mcpResourceUrls,
  requestOrigin,
  servesProtectedResourceMetadata,
} from './protected-resource.js';
import {
  AGENT_MCP_ROUTE_TOOLS,
  AGENT_MCP_SERVER_OPTIONS,
  AGENT_MCP_SERVER_PATH,
} from './tokens.js';

/** Where the guard leaves the actor a request authenticated as, for the server built for it. */
export const MCP_ACTOR = Symbol.for('@dudousxd/nestjs-agent-mcp-server:actor');

/** The node request the MCP endpoint is served from, with what the guard attaches to it. */
export type McpHttpRequest = IncomingMessage & { body?: unknown; [MCP_ACTOR]?: Actor };

/** The actor the guard authenticated this request as, if it ran. */
export function mcpActorOf(request: unknown): Actor | undefined {
  if (typeof request !== 'object' || request === null) return undefined;
  return (request as McpHttpRequest)[MCP_ACTOR];
}

/**
 * The agent's gate on `@nestjs/mcp`'s endpoint, before the SDK runs: who is calling (the configured
 * `ActorResolver` — a bearer token, a session cookie, a gateway header), answered 401 with its
 * `WWW-Authenticate` challenge when nobody; and a personal agent calling a tool whose scope its
 * user did not grant, answered 403 `insufficient_scope` so the client can step up. The actor it
 * resolved is what every tool of this request is listed and run for.
 */
@Injectable()
export class AgentMcpAuthGuard implements CanActivate {
  /**
   * The agent's own policy — closed on this surface alone when `emptyRoles: 'deny'` says so — behind
   * `personalAgentGate` (idempotent).
   */
  readonly policy: RolesPolicy;

  constructor(
    @Inject(AGENT_MCP_SERVER_OPTIONS) private readonly options: AgentMcpServerModuleOptions,
    @Inject(AGENT_TOOL_REGISTRY) private readonly registry: ToolRegistry,
    @Inject(AGENT_ROLES_POLICY) policy: RolesPolicy,
    @Inject(AGENT_MCP_ROUTE_TOOLS) private readonly routeTools: ToolRegistry,
    @Inject(AGENT_MCP_SERVER_PATH) private readonly path: string,
  ) {
    this.policy = personalAgentGate(
      options.emptyRoles === 'deny' ? closeEmptyRoles(policy) : policy,
    );
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const req = context.switchToHttp().getRequest<McpHttpRequest>();
    const actor = await this.authenticate(req);
    await this.refuseMissingScope({ req, actor, body: req.body });
    req[MCP_ACTOR] = actor;
    return true;
  }

  /**
   * Resolve the caller, turning a refusal into one that carries its challenge: every 401 says
   * `Bearer` (`invalid_token` when a token was sent), and names the metadata document when one is
   * served. A resolver's own {@link McpChallengeException} keeps its own.
   */
  private async authenticate(req: McpHttpRequest): Promise<Actor> {
    try {
      return await authenticateMcpRequest({ auth: this.options.auth, request: req });
    } catch (error) {
      if (error instanceof McpChallengeException) {
        throw error.withResourceMetadata(this.resourceMetadataUrl(req));
      }
      if (error instanceof HttpException && error.getStatus() === 401) {
        const metadata = this.resourceMetadataUrl(req);
        throw new McpChallengeException(401, {
          ...(req.headers.authorization !== undefined ? { error: 'invalid_token' } : {}),
          description: error.message,
          ...(metadata !== undefined ? { resourceMetadataUrl: metadata } : {}),
        });
      }
      throw error;
    }
  }

  private resourceMetadataUrl(req: McpHttpRequest): string | undefined {
    if (!servesProtectedResourceMetadata(this.options.oauth)) return undefined;
    return mcpResourceUrls({ origin: requestOrigin(req, this.options.baseUrl), path: this.path })
      .metadata;
  }

  /**
   * A personal agent calling a tool it is OFFERED but whose scope its user did not grant: `403` with
   * `WWW-Authenticate: Bearer error="insufficient_scope", scope="…"` (RFC 6750 §3.1, the MCP scope
   * step-up, Poppy §4.3) before anything runs. Every message of a batched body is checked. Only tools
   * this surface exposes: any other name stays the server's own "unknown tool".
   */
  private async refuseMissingScope(input: {
    req: McpHttpRequest;
    actor: Actor;
    body: unknown;
  }): Promise<void> {
    const { req, actor, body } = input;
    for (const message of Array.isArray(body) ? body : [body]) {
      const call = message as { method?: unknown; params?: { name?: unknown } } | null;
      const name = call?.params?.name;
      if (call?.method !== 'tools/call' || typeof name !== 'string') continue;
      const spec = [this.registry, this.routeTools].find((source) => source.has(name))?.spec(name);
      if (spec === undefined) continue;
      const refusal = mcpExposureRefusal({
        name,
        kind: spec.kind,
        actions: this.options.actions ?? 'deny',
        ...(this.options.allowedTools !== undefined
          ? { allowedTools: this.options.allowedTools }
          : {}),
        ...(spec.presentation !== undefined ? { presentation: spec.presentation } : {}),
      });
      if (refusal !== undefined) continue;
      const missing = await missingScopes(actor, spec, this.policy);
      if (missing === null) continue;
      const metadata = this.resourceMetadataUrl(req);
      throw new McpChallengeException(403, {
        error: 'insufficient_scope',
        scope: missing.join(' '),
        description: `insufficient_scope: "${name}" needs the scope "${missing.join(' ')}"`,
        ...(metadata !== undefined ? { resourceMetadataUrl: metadata } : {}),
      });
    }
  }
}
