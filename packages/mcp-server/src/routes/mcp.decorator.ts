import 'reflect-metadata';

/** Where `@Mcp()` files what it was given, read back at boot by `McpRouteDiscoveryService`. */
export const MCP_ROUTE_METADATA = Symbol.for('@dudousxd/nestjs-agent-mcp-server:route');

/**
 * What `@Mcp()` takes. Everything an `@AiTool` declares that the route cannot state for itself —
 * and nothing the route already states, which is where the input schema comes from.
 */
export interface McpRouteOptions {
  /**
   * What calling this does. There is no default and nothing is inferred from the HTTP verb: a `GET`
   * that triggers a side effect and a `POST` that only searches are both ordinary, so a guess here
   * is wrong in both directions. One word from the author removes the whole class of accident.
   *
   * - `read` — listed and callable over MCP.
   * - `action` — neither listed nor callable unless the deployment sets `actions: 'execute'`, for
   *   the same reason an `action` `@AiTool` is not: nobody is attached to an MCP connection to give
   *   the approval it was declared to require.
   */
  kind: 'read' | 'action';
  /** What the tool does, in the words the model reads. The route's own name is not a description. */
  description: string;
  /**
   * The tool name an MCP client calls. Defaults to the controller and method — `OrdersController`'s
   * `findOne` becomes `orders_find_one`. Set it where the derived name would be wrong or unstable;
   * a rename of the method is a rename of the tool otherwise.
   */
  name?: string;
  /**
   * Roles allowed to call it, gated by the app's `RolesPolicy` exactly as an `@AiTool`'s are. Omit
   * to inherit the policy's defaults.
   *
   * This is NOT a substitute for the route's own `@UseGuards` — those still run on every call. It
   * is the outer gate: a tool the caller's roles do not reach is never listed and never dispatched.
   */
  roles?: string[];
  /** Whether the tool exists in this deployment at all. Omit → it does. */
  enabled?: boolean | (() => boolean | Promise<boolean>);
  /** Authz ability checked by an ability-aware `RolesPolicy`. Ignored by the default one. */
  ability?: string;
}

/** Thrown at boot for a route whose `@Mcp()` cannot be turned into a tool. Names the route. */
export class McpRouteDeclarationError extends Error {
  constructor(
    readonly route: string,
    reason: string,
  ) {
    super(`@Mcp() on ${route}: ${reason}`);
    this.name = 'McpRouteDeclarationError';
  }
}

function isKind(value: unknown): value is McpRouteOptions['kind'] {
  return value === 'read' || value === 'action';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isEnabled(value: unknown): value is McpRouteOptions['enabled'] {
  return typeof value === 'boolean' || typeof value === 'function';
}

/**
 * Check what `@Mcp()` was handed and return it as options, or throw {@link McpRouteDeclarationError}.
 *
 * `kind` is required by the type, so a TypeScript caller that omits it does not compile. This runs
 * anyway, at decoration time, because the type is not present at runtime — a JavaScript caller, a
 * transpile-only build, or an options object assembled behind an `unknown` all reach here, and a
 * route exposed to a program you did not write is the wrong place for a silent default.
 */
export function normalizeMcpRouteOptions(input: {
  options: unknown;
  route: string;
}): McpRouteOptions {
  const { options, route } = input;
  if (typeof options !== 'object' || options === null) {
    throw new McpRouteDeclarationError(route, 'it takes an options object.');
  }
  const kind: unknown = Reflect.get(options, 'kind');
  if (!isKind(kind)) {
    throw new McpRouteDeclarationError(
      route,
      'it needs an explicit kind — `read` or `action`. Nothing is inferred from the HTTP verb.',
    );
  }
  const description: unknown = Reflect.get(options, 'description');
  if (typeof description !== 'string' || description.trim().length === 0) {
    throw new McpRouteDeclarationError(
      route,
      'it needs a description — that is what the calling model reads to decide whether to use it.',
    );
  }
  const name: unknown = Reflect.get(options, 'name');
  if (name !== undefined && (typeof name !== 'string' || name.length === 0)) {
    throw new McpRouteDeclarationError(route, 'its `name` must be a non-empty string.');
  }
  const roles: unknown = Reflect.get(options, 'roles');
  if (roles !== undefined && !isStringArray(roles)) {
    throw new McpRouteDeclarationError(route, 'its `roles` must be an array of strings.');
  }
  const enabled: unknown = Reflect.get(options, 'enabled');
  if (enabled !== undefined && !isEnabled(enabled)) {
    throw new McpRouteDeclarationError(route, 'its `enabled` must be a boolean or a function.');
  }
  const ability: unknown = Reflect.get(options, 'ability');
  if (ability !== undefined && typeof ability !== 'string') {
    throw new McpRouteDeclarationError(route, 'its `ability` must be a string.');
  }
  return {
    kind,
    description,
    ...(name !== undefined ? { name } : {}),
    ...(roles !== undefined ? { roles } : {}),
    ...(enabled !== undefined ? { enabled } : {}),
    ...(ability !== undefined ? { ability } : {}),
  };
}

/**
 * Expose an existing controller route to MCP clients as a tool.
 *
 * The input schema is derived from the route's own `@Param()` / `@Query()` / `@Body()` declarations,
 * and a call is dispatched through the request pipeline — the route's guards, pipes and
 * interceptors all run — so the capability is stated once, as a route, rather than twice.
 *
 * ```ts
 * @Controller('orders')
 * class OrdersController {
 *   @Get(':id')
 *   @UseGuards(JwtGuard, OrderAccessGuard)
 *   @Mcp({ kind: 'read', description: 'Read one order by its id.' })
 *   findOne(@Param('id') id: string) { ... }
 * }
 * ```
 */
export function Mcp(options: McpRouteOptions): MethodDecorator {
  return (target, propertyKey, descriptor) => {
    const owner: unknown = Reflect.get(target, 'constructor');
    const ownerName =
      typeof owner === 'function' && typeof owner.name === 'string' ? owner.name : 'a controller';
    const normalized = normalizeMcpRouteOptions({
      options,
      route: `${ownerName}.${String(propertyKey)}`,
    });
    Reflect.defineMetadata(MCP_ROUTE_METADATA, normalized, target, propertyKey);
    return descriptor;
  };
}

/** What `@Mcp()` declared on this method, or `undefined` when it carries none. */
export function readMcpRouteMetadata(input: {
  prototype: object;
  methodName: string;
}): McpRouteOptions | undefined {
  const value: unknown = Reflect.getMetadata(MCP_ROUTE_METADATA, input.prototype, input.methodName);
  return typeof value === 'object' && value !== null && isKind(Reflect.get(value, 'kind'))
    ? normalizeMcpRouteOptions({ options: value, route: input.methodName })
    : undefined;
}
