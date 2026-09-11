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
  ListToolsRequestSchema,
  type RequestId,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import {
  type McpActionPolicy,
  assertToolExposedOverMcp,
  isToolExposedOverMcp,
} from './exposed-tools.js';
import { actorFromAuthInfo } from './mcp-actor.js';
import { toMcpInputSchema } from './tool-json-schema.js';

/** Options for {@link createAgentMcpServer}. */
export interface CreateAgentMcpServerOptions {
  /** Server name reported to MCP clients in the initialize handshake. */
  name: string;
  /** Server version reported to MCP clients. */
  version: string;
  /** The tool registry to expose — the SAME one the agent loop runs tools from. */
  registry: ToolRegistry;
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
 * - `tools/list` → `registry.definitionsFor(actor, policy, allowedTools)`, which applies the same
 *   four layers a turn does (allow-list, `enabled`, `RolesPolicy`, the tool's own `canUse`), then
 *   drops every kind this surface will not run (see `mcpExposureRefusal`).
 * - `tools/call` → the exposure gate again, then `registry.invoke`, which re-checks `enabled`, the
 *   `RolesPolicy` and `canUse` and re-validates the input before the handler runs. A client holding
 *   a list from before a role changed therefore gains nothing by calling from it.
 *
 * The acting actor comes from the transport's verified `AuthInfo` on EVERY request, so a long-lived
 * MCP session cannot outlive the identity it was opened with: each request is gated against whoever
 * that request authenticated as.
 */
export function createAgentMcpServer(options: CreateAgentMcpServerOptions): Server {
  const { registry, policy, allowedTools } = options;
  const actions = options.actions ?? 'deny';
  const actorFromAuth = options.actorFromAuth ?? actorFromAuthInfo;
  const server = new Server(
    { name: options.name, version: options.version },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => {
    const actor = actorFromAuth(extra.authInfo);
    const definitions = await registry.definitionsFor(actor, policy, allowedTools);
    const exposed = definitions.filter((definition) =>
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
      const spec = registry.spec(name);
      if (spec === undefined) {
        throw new ToolNotFoundError(name);
      }
      assertToolExposedOverMcp({
        name,
        kind: spec.kind,
        actions,
        ...(allowedTools !== undefined ? { allowedTools } : {}),
      });
      const ctx = toolContext({ actor, sessionId: extra.sessionId, requestId: extra.requestId });
      const output = await registry.invoke(name, args ?? {}, ctx, policy);
      return { content: [{ type: 'text', text: asText(output) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: 'text', text: message }], isError: true };
    }
  });

  return server;
}
