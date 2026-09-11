import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  AGENT_ROLES_POLICY,
  AGENT_TOOL_REGISTRY,
  type Actor,
  type RolesPolicy,
  type ToolRegistry,
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
  Inject,
  NotFoundException,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { createAgentMcpServer } from './agent-mcp-server.js';
import type { AgentMcpServerModuleOptions } from './agent-mcp-server.options.js';
import { authenticateMcpRequest } from './authenticate.js';
import type { McpAuthInfo } from './mcp-actor.js';
import { type McpSession, McpSessionStore } from './mcp-sessions.js';
import { AGENT_MCP_SERVER_OPTIONS } from './tokens.js';

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
 * unidentified caller is answered 401 by the framework's own error path and the MCP machinery never
 * runs for them.
 */
@Controller()
export class AgentMcpServerController {
  constructor(
    @Inject(AGENT_MCP_SERVER_OPTIONS) private readonly options: AgentMcpServerModuleOptions,
    @Inject(AGENT_TOOL_REGISTRY) private readonly registry: ToolRegistry,
    @Inject(AGENT_ROLES_POLICY) private readonly policy: RolesPolicy,
    private readonly sessions: McpSessionStore,
  ) {}

  @Post()
  async post(
    @Req() req: McpHttpRequest,
    @Res() res: ServerResponse,
    @Body() body: unknown,
  ): Promise<void> {
    const actor = await this.authenticate(req);
    req.auth = authInfoFor(actor);
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

  private authenticate(req: McpHttpRequest): Promise<Actor> {
    return authenticateMcpRequest({ auth: this.options.auth, request: req });
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
      policy: this.policy,
      ...(this.options.actions !== undefined ? { actions: this.options.actions } : {}),
      ...(this.options.allowedTools !== undefined
        ? { allowedTools: this.options.allowedTools }
        : {}),
    });
    // The SDK's own transports expose `onclose`/`sessionId` as `... | undefined` where the
    // `Transport` interface declares the property optional, which `exactOptionalPropertyTypes`
    // reads as a mismatch — the class does implement the interface it is declared against.
    await server.connect(transport as Transport);
    return transport;
  }
}
