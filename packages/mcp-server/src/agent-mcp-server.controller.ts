import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
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
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpException,
  Inject,
  NotFoundException,
  Post,
  Req,
  Res,
  UseFilters,
} from '@nestjs/common';
import { createAgentMcpServer } from './agent-mcp-server.js';
import type { AgentMcpServerModuleOptions } from './agent-mcp-server.options.js';
import { authenticateMcpRequest } from './authenticate.js';
import { mcpExposureRefusal } from './exposed-tools.js';
import type { McpAuthInfo } from './mcp-actor.js';
import { McpChallengeException, McpChallengeFilter } from './mcp-challenge.js';
import { type McpSession, McpSessionStore } from './mcp-sessions.js';
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

/** The node request the MCP transport reads, with the slot it takes the verified identity from. */
type McpHttpRequest = IncomingMessage & { auth?: AuthInfo };

function readSessionId(req: IncomingMessage): string | undefined {
  const value = req.headers['mcp-session-id'];
  const sessionId = Array.isArray(value) ? value[0] : value;
  return sessionId === undefined || sessionId.length === 0 ? undefined : sessionId;
}

/**
 * The transport's `AuthInfo` slot is how the acting actor reaches the `tools/list` / `tools/call`
 * handlers. Its OAuth fields carry nothing here: this server authenticates through the host's
 * {@link AgentMcpServerModuleOptions.auth} resolver, which may read a bearer token, a session
 * cookie, or a gateway header, and only the actor it resolved is authoritative downstream.
 */
function authInfoFor(actor: Actor): McpAuthInfo {
  return { token: '', clientId: actor.id, scopes: [], extra: { actor } };
}

/**
 * The MCP Streamable HTTP endpoint: `POST` (initialize + requests), `GET` (the server-to-client SSE
 * stream) and `DELETE` (terminate the session), all at the configured route.
 *
 * Every one of them authenticates FIRST, before the transport is handed the request — so an
 * unidentified caller is answered 401, with its `WWW-Authenticate` challenge, and the MCP machinery
 * never runs for them.
 */
@Controller()
@UseFilters(McpChallengeFilter)
export class AgentMcpServerController {
  /**
   * The agent's own policy — closed on this surface alone when `emptyRoles: 'deny'` says so — behind
   * `personalAgentGate` (idempotent): a personal agent is offered the tools written for personal
   * agents and runs only those of its granted scopes. A no-op for every other actor.
   */
  private readonly policy: RolesPolicy;

  constructor(
    @Inject(AGENT_MCP_SERVER_OPTIONS) private readonly options: AgentMcpServerModuleOptions,
    @Inject(AGENT_TOOL_REGISTRY) private readonly registry: ToolRegistry,
    @Inject(AGENT_ROLES_POLICY) policy: RolesPolicy,
    @Inject(AGENT_MCP_ROUTE_TOOLS) private readonly routeTools: ToolRegistry,
    private readonly sessions: McpSessionStore,
    @Inject(AGENT_MCP_SERVER_PATH) private readonly path: string,
  ) {
    this.policy = personalAgentGate(
      options.emptyRoles === 'deny' ? closeEmptyRoles(policy) : policy,
    );
  }

  @Post()
  async post(
    @Req() req: McpHttpRequest,
    @Res() res: ServerResponse,
    @Body() body: unknown,
  ): Promise<void> {
    const actor = await this.authenticate(req);
    req.auth = authInfoFor(actor);
    await this.refuseMissingScope({ req, actor, body });
    const sessionId = readSessionId(req);
    if (sessionId !== undefined) {
      const session = this.requireSession({ sessionId, actor });
      await session.transport.handleRequest(req, res, body);
      return;
    }
    if (!isInitializeRequest(body)) {
      throw new BadRequestException(
        'Bad Request: no mcp-session-id header, and the body is not an initialize request.',
      );
    }
    const transport = await this.openSession(actor);
    await transport.handleRequest(req, res, body);
  }

  @Get()
  async get(@Req() req: McpHttpRequest, @Res() res: ServerResponse): Promise<void> {
    await this.onExistingSession({ req, res });
  }

  @Delete()
  async delete(@Req() req: McpHttpRequest, @Res() res: ServerResponse): Promise<void> {
    await this.onExistingSession({ req, res });
  }

  /** The GET/DELETE shape: both address a session that already exists, and neither carries a body. */
  private async onExistingSession(input: {
    req: McpHttpRequest;
    res: ServerResponse;
  }): Promise<void> {
    const { req, res } = input;
    const actor = await this.authenticate(req);
    req.auth = authInfoFor(actor);
    const sessionId = readSessionId(req);
    if (sessionId === undefined) {
      throw new BadRequestException('Bad Request: no mcp-session-id header.');
    }
    const session = this.requireSession({ sessionId, actor });
    await session.transport.handleRequest(req, res);
  }

  /**
   * Resolve the caller, turning a refusal into one that carries its challenge: every 401 says
   * `Bearer` (`invalid_token` when a token was sent), and names the metadata document when one is
   * served, so an OAuth-aware client knows where to log in. A resolver's own
   * {@link McpChallengeException} (`sign_in_required`, a verifier's DPoP challenge) keeps its own.
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

  /** This endpoint's metadata URL, when a document is served (an `oauth` option or a Poppy issuer). */
  private resourceMetadataUrl(req: McpHttpRequest): string | undefined {
    if (!servesProtectedResourceMetadata(this.options.oauth)) return undefined;
    return mcpResourceUrls({ origin: requestOrigin(req, this.options.baseUrl), path: this.path })
      .metadata;
  }

  /**
   * A personal agent calling a tool it is OFFERED but whose scope its user did not grant: `403` with
   * `WWW-Authenticate: Bearer error="insufficient_scope", scope="…"` (RFC 6750 §3.1, the MCP scope
   * step-up, Poppy §4.3) before anything runs — the client asks its user for that scope, where a tool
   * error would read to a model as "try different arguments". Every message of a batched body is
   * checked. Only tools this surface exposes: any other name stays the server's own "unknown tool".
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

  /**
   * The session this request names, provided the caller owns it. An unknown id is 404 so the client
   * re-initializes rather than retrying a session this process no longer holds; a session opened by
   * a different actor is 403 — the id is a bearer capability travelling in a plain header, and the
   * session owns an open stream that answers belonging to its opener are written to.
   */
  private requireSession(input: { sessionId: string; actor: Actor }): McpSession {
    const session = this.sessions.get(input.sessionId);
    if (session === undefined) {
      throw new NotFoundException('Unknown or expired MCP session id.');
    }
    if (session.actorId !== input.actor.id) {
      throw new ForbiddenException('This MCP session was opened by a different actor.');
    }
    return session;
  }

  private async openSession(actor: Actor): Promise<StreamableHTTPServerTransport> {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        this.sessions.open({ sessionId, session: { transport, actorId: actor.id } });
      },
      onsessionclosed: (sessionId) => {
        this.sessions.close(sessionId);
      },
    });
    transport.onclose = () => {
      const sessionId = transport.sessionId;
      if (sessionId !== undefined) {
        this.sessions.close(sessionId);
      }
    };
    const server = createAgentMcpServer({
      name: this.options.name,
      version: this.options.version,
      registry: this.registry,
      routeTools: this.routeTools,
      policy: this.policy,
      ...(this.options.actions !== undefined ? { actions: this.options.actions } : {}),
      ...(this.options.allowedTools !== undefined
        ? { allowedTools: this.options.allowedTools }
        : {}),
      ...(this.options.context !== undefined ? { context: this.options.context } : {}),
    });
    // The SDK's own transports expose `onclose`/`sessionId` as `... | undefined` where the
    // `Transport` interface declares the property optional, which `exactOptionalPropertyTypes`
    // reads as a mismatch — the class does implement the interface it is declared against.
    await server.connect(transport as Transport);
    return transport;
  }
}
