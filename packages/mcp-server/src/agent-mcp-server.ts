import type {
  Actor,
  AiToolCtx,
  RolesPolicy,
  ToolDefinition,
  ToolRegistry,
} from '@dudousxd/nestjs-agent-core';
import { ToolNotFoundError } from '@dudousxd/nestjs-agent-core';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type RequestId,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import {
  type McpActionPolicy,
  assertToolExposedOverMcp,
  isToolExposedOverMcp,
} from './exposed-tools.js';
import { actorFromAuthInfo } from './mcp-actor.js';
import { McpRouteHttpError } from './routes/mcp-route-dispatcher.js';
import { toMcpInputSchema } from './tool-json-schema.js';

/**
 * What a host can tell about one `tools/call` beyond its caller: the conversation it belongs to and
 * where a component the tool pushes should go. Given the request's `_meta` (OpenCode sends its
 * session as `ai.opencode/sessionID`), the caller and the tool's name; whatever it returns replaces
 * those fields of the context the tool is handed. `undefined` → the MCP call stands on its own.
 */
export type McpToolContextResolver = (input: {
  actor: Actor;
  toolName: string;
  meta: Readonly<Record<string, unknown>> | undefined;
}) =>
  | Partial<Pick<AiToolCtx, 'threadId' | 'runId' | 'requestId' | 'emitUi' | 'agentName'>>
  | undefined
  | Promise<
      | Partial<Pick<AiToolCtx, 'threadId' | 'runId' | 'requestId' | 'emitUi' | 'agentName'>>
      | undefined
    >;

/** Options for {@link createAgentMcpServer}. */
export interface CreateAgentMcpServerOptions {
  /** Server name reported to MCP clients in the initialize handshake. */
  name: string;
  /** Server version reported to MCP clients. */
  version: string;
  /** The tool registry to expose — the SAME one the agent loop runs tools from. */
  registry: ToolRegistry;
  /**
   * Tools derived from `@Mcp()` controller routes, served alongside `registry` and gated exactly as
   * it is. Omit where the deployment exposes no routes.
   */
  routeTools?: ToolRegistry;
  /** The tool authorization gate — the SAME `RolesPolicy` the agent loop gates turns with. */
  policy: RolesPolicy;
  /** What an `action` tool means here. Defaults to `'deny'`. See {@link McpActionPolicy}. */
  actions?: McpActionPolicy;
  /** Names this surface exposes. Omit → every tool of an exposable kind the caller may use. */
  allowedTools?: string[];
  /**
   * How the acting actor is read from the transport's verified auth. Defaults to
   * `actorFromAuthInfo`, which refuses a request carrying no identity.
   */
  actorFromAuth?: (authInfo: AuthInfo | undefined) => Actor;
  /** Ties a call to the conversation it serves — see {@link McpToolContextResolver}. */
  context?: McpToolContextResolver;
}

/** The per-call context handed to a tool handler. No run exists, so the ids name the MCP call. */
function toolContext(input: {
  actor: Actor;
  sessionId: string | undefined;
  requestId: RequestId;
}): AiToolCtx {
  const { actor, sessionId, requestId } = input;
  const session = sessionId ?? actor.id;
  return {
    actor,
    threadId: `mcp:${session}`,
    runId: `mcp:${session}:${String(requestId)}`,
    requestId: `mcp:${session}:${String(requestId)}`,
    // No conversation to push into: a tool's `ctx.emitUi` is accepted and dropped. Written out
    // rather than taken from core so this package keeps working against the older cores it allows.
    emitUi: noopEmitUi(`mcp:${session}:${String(requestId)}`),
  };
}

function noopEmitUi(scope: string): AiToolCtx['emitUi'] {
  let next = 0;
  return async (_component, _props, options = {}) => {
    if (options.id !== undefined) return { id: options.id };
    const id = `${scope}:ui:${next}`;
    next += 1;
    return { id };
  };
}

function describe(definition: ToolDefinition): Tool {
  return {
    name: definition.name,
    description: definition.description,
    inputSchema: toMcpInputSchema(definition.inputSchema),
    // The one thing a client can act on without knowing this library's kinds: whether calling it
    // changes anything. `action` reaches here only under `actions: 'execute'`.
    annotations: { readOnlyHint: definition.kind === 'read' },
  };
}

function asText(output: unknown): string {
  return typeof output === 'string' ? output : JSON.stringify(output);
}

/**
 * An MCP `Server` that exposes this deployment's tools to an external MCP client.
 *
 * Both halves run against the agent's own registry and policy — not a second gate that happens to
 * agree with them:
 *
 * - `tools/list` → `definitionsFor(actor, policy, allowedTools)`, which applies the same four
 *   layers a turn does (allow-list, `enabled`, `RolesPolicy`, the tool's own `canUse`), then drops
 *   every kind this surface will not run (see `mcpExposureRefusal`).
 * - `tools/call` → the exposure gate again, then `invoke`, which re-checks `enabled`, the
 *   `RolesPolicy` and `canUse` and re-validates the input before the handler runs. A client holding
 *   a list from before a role changed therefore gains nothing by calling from it.
 *
 * Tools derived from `@Mcp()` controller routes live in a registry of their own and go through both
 * halves on identical terms — a second door into the same house, not a way around it.
 *
 * The acting actor comes from the transport's verified `AuthInfo` on EVERY request, so a long-lived
 * MCP session cannot outlive the identity it was opened with: each request is gated against whoever
 * that request authenticated as.
 */
export function createAgentMcpServer(options: CreateAgentMcpServerOptions): Server {
  const { registry, policy, allowedTools } = options;
  const actions = options.actions ?? 'deny';
  const actorFromAuth = options.actorFromAuth ?? actorFromAuthInfo;
  // Two registries, one set of gates: each is asked the same question with the same actor, policy
  // and allow-list, and the exposure decision is applied to the answers together.
  const registries: ToolRegistry[] =
    options.routeTools === undefined ? [registry] : [registry, options.routeTools];
  const server = new Server(
    { name: options.name, version: options.version },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => {
    const actor = actorFromAuth(extra.authInfo);
    const listed = await Promise.all(
      registries.map((source) => source.definitionsFor(actor, policy, allowedTools)),
    );
    const exposed = listed
      .flat()
      .filter((definition) =>
        isToolExposedOverMcp({ name: definition.name, kind: definition.kind, actions }),
      );
    return { tools: exposed.map(describe) };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    // Outside the try: a request with no resolvable identity is a protocol error, not a tool that
    // failed. A client must be able to tell "you are not authenticated" from "the tool said no".
    const actor = actorFromAuth(extra.authInfo);
    const { name, arguments: args } = request.params;
    try {
      const source = registries.find((candidate) => candidate.has(name));
      const spec = source?.spec(name);
      if (source === undefined || spec === undefined) {
        throw new ToolNotFoundError(name);
      }
      assertToolExposedOverMcp({
        name,
        kind: spec.kind,
        actions,
        ...(allowedTools !== undefined ? { allowedTools } : {}),
      });
      const base = toolContext({ actor, sessionId: extra.sessionId, requestId: extra.requestId });
      const meta = request.params._meta as Readonly<Record<string, unknown>> | undefined;
      const ctx: AiToolCtx = {
        ...base,
        ...((await options.context?.({ actor, toolName: name, meta })) ?? {}),
      };
      const output = await source.invoke(name, args ?? {}, ctx, policy);
      return { content: [{ type: 'text', text: asText(output) }] };
    } catch (error) {
      // A route answered this call with a status. That is the route's verdict on the CALL, not a
      // result the tool produced: reporting a 403 as ordinary tool output would read to a model as
      // "that did not work, try different arguments", when the answer is that this caller may not
      // do it at all. It travels as a protocol error, carrying the status the route chose.
      if (error instanceof McpRouteHttpError) {
        throw new McpError(errorCodeForStatus(error.status), error.message, {
          httpStatus: error.status,
        });
      }
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: 'text', text: message }], isError: true };
    }
  });

  return server;
}

/** The JSON-RPC code that says the same thing as an HTTP status. */
function errorCodeForStatus(status: number): ErrorCode {
  if (status === 400 || status === 422) {
    return ErrorCode.InvalidParams;
  }
  return status >= 500 ? ErrorCode.InternalError : ErrorCode.InvalidRequest;
}
