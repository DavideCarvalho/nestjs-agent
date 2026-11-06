import type {
  Actor,
  AiToolCtx,
  RolesPolicy,
  ToolDefinition,
  ToolRegistry,
} from '@dudousxd/nestjs-agent-core';
import {
  type CallToolResult,
  type McpServer,
  type RequestId,
  type ServerContext,
  fromJsonSchema,
} from '@modelcontextprotocol/server';
import {
  type McpActionPolicy,
  assertToolExposedOverMcp,
  isToolExposedOverMcp,
} from './exposed-tools.js';
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
  /** This call's id on the MCP surface (`mcp:<session>:<request>`) — unique per call. */
  requestId: string;
  meta: Readonly<Record<string, unknown>> | undefined;
}) =>
  | Partial<Pick<AiToolCtx, 'threadId' | 'runId' | 'requestId' | 'emitUi' | 'agentName'>>
  | undefined
  | Promise<
      | Partial<Pick<AiToolCtx, 'threadId' | 'runId' | 'requestId' | 'emitUi' | 'agentName'>>
      | undefined
    >;

/** Options for {@link registerAgentTools}. */
export interface RegisterAgentToolsOptions {
  /** Who this server answers for: the actor the request (or the stdio connection) authenticated as. */
  actor: Actor;
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
  /** Ties a call to the conversation it serves — see {@link McpToolContextResolver}. */
  context?: McpToolContextResolver;
  /** Told about a tool it could not register (a name `@nestjs/mcp`'s own `@Tool()` already took). */
  onSkipped?: (name: string, reason: string) => void;
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
    // No conversation to push into: a tool's `ctx.emitUi` is accepted and dropped.
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

function asText(output: unknown): string {
  return typeof output === 'string' ? output : JSON.stringify(output);
}

/**
 * Registers on `server` — an SDK server `@nestjs/mcp` built for one request — the agent's tools that
 * `actor` may use, and only those: `tools/list` is the agent's own answer for this caller, not the
 * whole registry. Returns the names it registered.
 *
 * Both halves run against the agent's own registry and policy, not a second gate that happens to
 * agree with them:
 *
 * - What is registered → `definitionsFor(actor, policy, allowedTools)`, the same four layers a turn
 *   applies (allow-list, `enabled`, `RolesPolicy` with the tool's `@Can()`, the tool's own `canUse`),
 *   less every kind this surface will not run (see `mcpExposureRefusal`).
 * - A call → the exposure gate again, then `invoke`, which re-checks `enabled`, the policy and
 *   `canUse` and re-validates the input before the handler runs.
 *
 * Tools derived from `@Mcp()` controller routes live in a registry of their own and go through both
 * halves on identical terms — a second door into the same house, not a way around it.
 */
export async function registerAgentTools(
  server: McpServer,
  options: RegisterAgentToolsOptions,
): Promise<string[]> {
  const { actor, registry, policy, allowedTools } = options;
  const actions = options.actions ?? 'deny';
  const registries: ToolRegistry[] =
    options.routeTools === undefined ? [registry] : [registry, options.routeTools];
  const listed = await Promise.all(
    registries.map((source) => source.definitionsFor(actor, policy, allowedTools)),
  );
  const sourceOf = (name: string) => registries.find((candidate) => candidate.has(name));
  const exposed = listed.flat().filter((definition) => {
    const presentation = sourceOf(definition.name)?.spec(definition.name)?.presentation;
    return isToolExposedOverMcp({
      name: definition.name,
      kind: definition.kind,
      actions,
      ...(presentation !== undefined ? { presentation } : {}),
    });
  });

  const registered: string[] = [];
  for (const definition of exposed) {
    const name = definition.name;
    try {
      server.registerTool(
        name,
        {
          description: definition.description,
          inputSchema: fromJsonSchema(toMcpInputSchema(definition.inputSchema)),
          // The one thing a client can act on without knowing this library's kinds: whether calling
          // it changes anything. `action` reaches here only under `actions: 'execute'`.
          annotations: { readOnlyHint: definition.kind === 'read' },
        },
        (args: unknown, ctx: ServerContext) => call(name, args, ctx),
      );
      registered.push(name);
    } catch (error) {
      options.onSkipped?.(name, error instanceof Error ? error.message : String(error));
    }
  }
  return registered;

  async function call(name: string, args: unknown, ctx: ServerContext): Promise<CallToolResult> {
    try {
      const source = sourceOf(name);
      const spec = source?.spec(name);
      if (source === undefined || spec === undefined) {
        return { content: [{ type: 'text', text: `Unknown tool "${name}".` }], isError: true };
      }
      assertToolExposedOverMcp({
        name,
        kind: spec.kind,
        actions,
        ...(allowedTools !== undefined ? { allowedTools } : {}),
        ...(spec.presentation !== undefined ? { presentation: spec.presentation } : {}),
      });
      const base = toolContext({ actor, sessionId: ctx.sessionId, requestId: ctx.mcpReq.id });
      const meta = ctx.mcpReq._meta as Readonly<Record<string, unknown>> | undefined;
      const toolCtx: AiToolCtx = {
        ...base,
        ...((await options.context?.({ actor, toolName: name, requestId: base.requestId, meta })) ??
          {}),
      };
      const output = await source.invoke(name, args ?? {}, toolCtx, policy);
      return { content: [{ type: 'text', text: asText(output) }] };
    } catch (error) {
      // A route answered this call with a status: the route's verdict on the CALL, not a result the
      // tool produced. The SDK reports every error a tool throws as a tool result, so the verdict
      // travels as one that says so — the status leads the message (a model must not read a 403 as
      // "try different arguments") and rides in `_meta` for a client that acts on it.
      if (error instanceof McpRouteHttpError) {
        return {
          content: [{ type: 'text', text: `${error.status}: ${error.message}` }],
          isError: true,
          _meta: { httpStatus: error.status },
        };
      }
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: 'text', text: message }], isError: true };
    }
  }
}

/** What `tools/list` would describe for `definition` — for callers that build their own listing. */
export function describeAgentTool(definition: ToolDefinition): {
  name: string;
  description: string;
  inputSchema: ReturnType<typeof toMcpInputSchema>;
  annotations: { readOnlyHint: boolean };
} {
  return {
    name: definition.name,
    description: definition.description,
    inputSchema: toMcpInputSchema(definition.inputSchema),
    annotations: { readOnlyHint: definition.kind === 'read' },
  };
}
