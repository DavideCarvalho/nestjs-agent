import type { Actor, ToolHandler, ToolRegistry, ToolSpec } from '@dudousxd/nestjs-agent-core';
import type { McpRouteRef } from './mcp-route-dispatcher.js';
import type { McpRouteOptions } from './mcp.decorator.js';
import type { NestRoute } from './nest-route-metadata.js';
import { type McpRouteInput, routeInputSchema } from './route-input-schema.js';

/** One route exposed over MCP: the tool it registers as, and the route it stands for. */
export interface McpRouteTool {
  spec: ToolSpec;
  handler: ToolHandler;
  route: McpRouteRef;
}

/** `findOne` → `find_one`, `listForOrder` → `list_for_order`, `readHTTPLog` → `read_http_log`. */
export function snakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

/**
 * The tool name a route gets when `@Mcp()` does not name one: the controller, without its
 * `Controller` suffix, and the method — `OrdersController.findOne` → `orders_find_one`.
 *
 * A rename of the method renames the tool, which is why `@Mcp({ name })` exists: a client's
 * configuration names tools, so a surface with external callers should say the name out loud.
 */
export function defaultRouteToolName(input: {
  controllerName: string;
  methodName: string;
}): string {
  const owner = input.controllerName.replace(/Controller$/, '');
  const prefix = snakeCase(owner);
  const method = snakeCase(input.methodName);
  return prefix.length === 0 ? method : `${prefix}_${method}`;
}

function isRouteInput(value: unknown): value is McpRouteInput {
  return (
    typeof value === 'object' &&
    value !== null &&
    'params' in value &&
    'query' in value &&
    'hasBody' in value
  );
}

/** What one `@Mcp()` route is called and where it points. Built once, so the tool and the
 * dispatcher name the same thing. */
export function routeToolRef(input: {
  options: McpRouteOptions;
  route: NestRoute;
  controllerName: string;
  methodName: string;
}): McpRouteRef {
  const { options, route, controllerName, methodName } = input;
  return {
    tool: options.name ?? defaultRouteToolName({ controllerName, methodName }),
    method: route.method,
    path: route.path,
    handler: `${controllerName}.${methodName}`,
  };
}

/**
 * Turn one discovered route into a registrable tool.
 *
 * The spec is an ordinary `ToolSpec` — the same shape an `@AiTool` produces — so every gate the
 * package already applies applies to it unchanged: the `RolesPolicy` is asked about it, `enabled`
 * drops it, the `action` policy decides whether it is listed or callable at all, and the allow-list
 * is re-checked on the call. Nothing here is a second set of rules that happens to agree.
 */
export function buildRouteTool(input: {
  options: McpRouteOptions;
  route: NestRoute;
  ref: McpRouteRef;
  dispatch: (args: McpRouteInput, actor: Actor) => Promise<unknown>;
}): McpRouteTool {
  const { options, route, ref, dispatch } = input;
  return {
    route: ref,
    spec: {
      name: ref.tool,
      kind: options.kind,
      description: options.description,
      inputSchema: routeInputSchema(route),
      ...(options.roles !== undefined ? { roles: options.roles } : {}),
      ...(options.enabled !== undefined ? { enabled: options.enabled } : {}),
      ...(options.ability !== undefined ? { ability: options.ability } : {}),
    },
    handler: {
      execute: async (args, ctx) => {
        if (!isRouteInput(args)) {
          throw new Error(
            `Tool "${ref.tool}" was dispatched with arguments its schema did not produce.`,
          );
        }
        return dispatch(args, ctx.actor);
      },
    },
  };
}

/** Thrown at boot when one tool name would answer for two different things. */
export class McpRouteToolNameCollisionError extends Error {
  constructor(
    readonly toolName: string,
    reason: string,
  ) {
    super(`Two things claim the MCP tool name "${toolName}": ${reason}`);
    this.name = 'McpRouteToolNameCollisionError';
  }
}

/**
 * Refuse a boot where a name answers for more than one thing.
 *
 * A registry resolves a duplicate by keeping the last writer, which on this surface means a caller
 * asking for the tool they were shown reaches the other one — silently, and differently depending on
 * the order modules happened to load in. Both claimants are named so the fix is obvious.
 */
export function assertRouteToolNamesAreFree(input: {
  tools: readonly McpRouteTool[];
  aiTools: ToolRegistry;
}): void {
  const seen = new Map<string, McpRouteRef>();
  for (const tool of input.tools) {
    const { tool: name, handler } = tool.route;
    const previous = seen.get(name);
    if (previous !== undefined) {
      throw new McpRouteToolNameCollisionError(
        name,
        `the routes ${previous.handler} and ${handler}. Give one of them @Mcp({ name }).`,
      );
    }
    if (input.aiTools.has(name)) {
      throw new McpRouteToolNameCollisionError(
        name,
        `the @AiTool of that name and the route ${handler}. Rename one of them.`,
      );
    }
    seen.set(name, tool.route);
  }
}
