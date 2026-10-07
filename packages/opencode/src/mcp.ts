import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  type Actor,
  REMEMBER_TOOL_DESCRIPTION,
  REMEMBER_TOOL_NAME,
  type RememberToolInput,
  ToolNotFoundError,
  rememberInputSchema,
  schemaExtensionOf,
} from '@dudousxd/nestjs-agent-core';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { AnyObjectSchema } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { errorText } from './turn.js';
import type { OpenCodeCallContext, OpenCodeTurns } from './turns.js';

/** What a tools token says: whose turns it may serve, on which OpenCode server, until when. */
export interface OpenCodeToolsClaims {
  v: 1;
  actor: Actor;
  /** The OpenCode server key (`OpenCodeServer.key`) the token was registered on. */
  server: string;
  /** Epoch ms after which the token is refused. */
  exp: number;
}

/** Kinds the LOOP serves (delegation, `ask`, `skill`, `remember`): never served over MCP. */
export const LOOP_SERVED_KINDS: ReadonlySet<string> = new Set(['agent', 'ask', 'skill', 'memory']);

const b64url = (data: Buffer | string) => Buffer.from(data).toString('base64url');

/**
 * Signs and checks the bearer tokens the engine registers its tools endpoint with (`mcp.add`). A
 * token names an actor and an OpenCode server, and expires; it is HMAC-SHA256 over its claims with
 * a key derived from `tools.secret`.
 *
 * A token on its own runs nothing: the endpoint also needs the call to come from a session that is
 * running a turn of that actor right now (see `OpenCodeTurns.callContext`), and an `action` tool
 * needs an approval the turn granted (see `OpenCodeTurns.spendApproval`).
 */
export class OpenCodeToolsTokens {
  private readonly key: Buffer;

  constructor(
    secret: string | undefined,
    readonly ttlMs: number,
  ) {
    this.key = createHash('sha256')
      .update('aviary:opencode:tools\0')
      .update(secret ?? randomBytes(32).toString('hex'))
      .digest();
  }

  mint(actor: Actor, server: string, now = Date.now()): string {
    const claims: OpenCodeToolsClaims = { v: 1, actor, server, exp: now + this.ttlMs };
    const body = b64url(JSON.stringify(claims));
    return `${body}.${this.sign(body)}`;
  }

  verify(token: string, now = Date.now()): OpenCodeToolsClaims | null {
    const [body, signature, extra] = token.split('.');
    if (body === undefined || signature === undefined || extra !== undefined) return null;
    const expected = Buffer.from(this.sign(body));
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    try {
      const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as
        | Partial<OpenCodeToolsClaims>
        | undefined;
      if (
        claims?.v !== 1 ||
        typeof claims.server !== 'string' ||
        typeof claims.exp !== 'number' ||
        typeof claims.actor?.id !== 'string' ||
        claims.exp <= now
      ) {
        return null;
      }
      return claims as OpenCodeToolsClaims;
    } catch {
      return null;
    }
  }

  private sign(body: string): string {
    return createHmac('sha256', this.key).update(body).digest('base64url');
  }
}

/** True for a Zod schema (its Standard Schema props say `vendor: 'zod'`). */
function isZodSchema(schema: StandardSchemaV1): schema is StandardSchemaV1 & AnyObjectSchema {
  return schema['~standard'].vendor === 'zod';
}

/** A tool's input schema as the JSON Schema MCP clients read — as `AgentMcpServerModule` does. */
function toInputSchema(schema: StandardSchemaV1): Tool['inputSchema'] {
  const extension = schemaExtensionOf(schema);
  if (extension !== undefined) {
    const base = toInputSchema(extension.base);
    const properties = { ...(base.properties ?? {}), ...extension.properties };
    return { ...base, properties: properties as Record<string, object> };
  }
  let converted: Record<string, unknown> | undefined;
  if (isZodSchema(schema)) converted = toJsonSchemaCompat(schema) as Record<string, unknown>;
  else {
    const converter = (schema['~standard'] as { jsonSchema?: { input?: unknown } }).jsonSchema;
    if (typeof converter?.input === 'function')
      converted = (converter.input as () => Record<string, unknown>)();
  }
  if (converted === undefined)
    return { type: 'object', properties: {}, additionalProperties: true };
  const { type: _type, ...rest } = converted;
  return { ...rest, type: 'object' } as Tool['inputSchema'];
}

const asText = (output: unknown) => (typeof output === 'string' ? output : JSON.stringify(output));

/** A call this endpoint will not run, said to the model as the tool's error. */
export class OpenCodeToolRefusedError extends Error {
  override readonly name = 'OpenCodeToolRefusedError';
}

/**
 * The MCP endpoint OpenCode sessions reach the module's tools through — `POST <agent path>/opencode/mcp`,
 * mounted by the engine when `tools` is set. Stateless Streamable HTTP (one server per request), so
 * any process answers.
 *
 * - `tools/list`: the registry's tools the token's actor may reach (roles, `enabled`, `canUse`), the
 *   kinds only the loop serves left out; with `_meta` naming a running turn, its agent's (and
 *   persona's) allow-list too. Plus `remember`, when the memory provider writes — served HERE only,
 *   never registered in the module's shared registry.
 * - `tools/call`: only for a call `_meta` ties to a turn of the token's actor running on that
 *   session, on the token's server; the turn's allow-list and the registry's own checks apply, an
 *   `action` runs only against an approval the turn granted (one call per approval), and the tool's
 *   `ctx` is the turn's (thread, run, `emitUi` into its stream and message).
 */
export class OpenCodeMcpEndpoint {
  constructor(
    private readonly turns: OpenCodeTurns,
    private readonly tokens: OpenCodeToolsTokens,
  ) {}

  /** The claims of a request's bearer token, or `null`. */
  authenticate(authorization: string | string[] | undefined): OpenCodeToolsClaims | null {
    const header = Array.isArray(authorization) ? authorization[0] : authorization;
    const match = /^Bearer\s+(.+)$/i.exec(header ?? '');
    const token = match?.[1]?.trim();
    return token ? this.tokens.verify(token) : null;
  }

  async handle(req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
    const claims = this.authenticate(req.headers.authorization);
    if (claims === null) {
      res.statusCode = 401;
      res.setHeader('WWW-Authenticate', 'Bearer error="invalid_token"');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    const server = this.server(claims);
    // No `sessionIdGenerator`: stateless, so any process answers any request.
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport as Transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32603, message: errorText(error, 'Internal error') },
            id: null,
          }),
        );
      }
    }
  }

  /** One MCP server for one request, answering as the token's actor. */
  server(claims: OpenCodeToolsClaims): Server {
    const server = new Server(
      { name: 'aviary-opencode', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );
    const { actor } = claims;
    const call = (meta: unknown, requestId: unknown) =>
      this.turns.callContext({
        actor,
        serverKey: claims.server,
        requestId: String(requestId ?? ''),
        meta: meta as Readonly<Record<string, unknown>> | undefined,
      });

    server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
      const turn = await call(request.params?._meta, extra.requestId);
      const input = turn?.input ?? {};
      const allowed = turn !== undefined ? this.turns.allowedTools(turn.input) : undefined;
      const definitions = (
        await this.turns.registry.definitionsFor(actor, this.turns.rolesPolicyFor(input), allowed)
      ).filter((definition) => !LOOP_SERVED_KINDS.has(definition.kind));
      const tools: Tool[] = definitions.map((definition) => ({
        name: definition.name,
        description: definition.description,
        inputSchema: toInputSchema(definition.inputSchema),
        annotations: { readOnlyHint: definition.kind === 'read' },
      }));
      if (this.turns.memoryWritable()) {
        tools.push({
          name: REMEMBER_TOOL_NAME,
          description: REMEMBER_TOOL_DESCRIPTION,
          inputSchema: toInputSchema(rememberInputSchema),
          annotations: { readOnlyHint: false },
        });
      }
      return { tools };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const { name, arguments: args } = request.params;
      try {
        const turn = await call(request.params._meta, extra.requestId);
        if (turn === undefined) {
          throw new OpenCodeToolRefusedError(
            'This endpoint serves OpenCode turns: no turn of yours is running on this session.',
          );
        }
        const output =
          name === REMEMBER_TOOL_NAME && this.turns.memoryWritable()
            ? await this.remember(turn, args)
            : await this.invoke(turn, actor, name, args, String(extra.requestId ?? ''));
        return { content: [{ type: 'text' as const, text: asText(output) }] };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: errorText(error, 'the tool failed') }],
          isError: true,
        };
      }
    });
    return server;
  }

  private async invoke(
    turn: OpenCodeCallContext,
    actor: Actor,
    name: string,
    args: unknown,
    requestId: string,
  ): Promise<unknown> {
    const { registry } = this.turns;
    const spec = registry.spec(name);
    if (spec === undefined || LOOP_SERVED_KINDS.has(spec.kind)) throw new ToolNotFoundError(name);
    const allowed = this.turns.allowedTools(turn.input);
    if (allowed !== undefined && !allowed.includes(name)) throw new ToolNotFoundError(name);
    if (spec.kind === 'action' && !(await this.turns.spendApproval(turn.runId, name, turn.input))) {
      throw new OpenCodeToolRefusedError(
        `"${name}" is an action and nobody approved this call; ask for the permission first.`,
      );
    }
    return registry.invoke(
      name,
      args ?? {},
      {
        actor,
        threadId: turn.ctx.threadId,
        runId: turn.runId,
        requestId: `mcp:${turn.runId}:${requestId}`,
        emitUi: turn.ctx.emitUi,
        ...(turn.input.agentName !== undefined ? { agentName: turn.input.agentName } : {}),
        ...(turn.input.persona !== undefined ? { persona: turn.input.persona } : {}),
        ...(turn.input.pageContext !== undefined ? { pageContext: turn.input.pageContext } : {}),
      },
      this.turns.rolesPolicyFor(turn.input),
      allowed !== undefined ? { allowedTools: allowed } : {},
    );
  }

  /** `remember`: one fact, at the actor's own scope only — as the loop serves it. */
  private async remember(turn: OpenCodeCallContext, args: unknown): Promise<string> {
    const parsed = await rememberInputSchema['~standard'].validate(args ?? {});
    if (parsed.issues !== undefined) {
      throw new OpenCodeToolRefusedError(
        `remember: ${parsed.issues.map((issue) => issue.message).join('; ')}`,
      );
    }
    return this.turns.remember(parsed.value as RememberToolInput, turn);
  }
}
