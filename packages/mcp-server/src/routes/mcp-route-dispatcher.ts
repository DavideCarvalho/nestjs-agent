import type { Actor } from '@dudousxd/nestjs-agent-core';
import { HttpException, Injectable } from '@nestjs/common';
import { ExternalContextCreator, type ParamsFactory } from '@nestjs/core';
import { ROUTE_ARGS_METADATA, ROUTE_PARAM } from './nest-route-metadata.js';
import type { McpRouteInput } from './route-input-schema.js';

/** Which route one tool stands for. Carried into errors and into the principal hook. */
export interface McpRouteRef {
  /** The tool name an MCP client calls. */
  tool: string;
  method: string;
  /** The path template, `:id` placeholders and all. */
  path: string;
  /** `OrdersController.findOne` — what a boot error names. */
  handler: string;
}

/** What the route's guards are given to authenticate against. */
export interface McpRoutePrincipal {
  /** The authenticated user, as the route's guards and `createParamDecorator`s read it. */
  user?: unknown;
  /** Headers the synthetic request carries. Lower-case names. */
  headers?: Record<string, string>;
}

/** How the MCP actor becomes the principal of the request a tool call dispatches. */
export type McpRoutePrincipalFactory = (input: {
  actor: Actor;
  route: McpRouteRef;
}) => McpRoutePrincipal;

/**
 * The default principal: the actor the MCP surface authenticated, on `request.user`.
 *
 * Nothing is copied from the inbound MCP HTTP request. The credential a caller presented to `/mcp`
 * authenticated them to THIS surface, through the `ActorResolver` the deployment configured; handing
 * it on to an internal route would both re-authenticate a token the route's guards were never meant
 * to accept and let an MCP caller put headers of their choosing in front of them. The identity that
 * crosses is the resolved actor and nothing else.
 *
 * `request.user` is where Passport, `AuthGuard`, and most hand-written guards look, and `Actor`'s
 * `{ id, roles }` is what a roles guard reads. A deployment whose guards expect a different shape —
 * a claims object, a service token — supplies its own factory and says so in its own code.
 */
export const defaultMcpRoutePrincipal: McpRoutePrincipalFactory = ({ actor }) => ({ user: actor });

/** An `HttpException` the route answered a dispatched tool call with. Keeps the status. */
export class McpRouteHttpError extends Error {
  constructor(
    readonly toolName: string,
    readonly status: number,
    reason: string,
  ) {
    super(`${reason} (HTTP ${status})`);
    this.name = 'McpRouteHttpError';
  }
}

/** The request a dispatched tool call presents to the route. */
interface McpSyntheticRequest {
  method: string;
  url: string;
  originalUrl: string;
  baseUrl: string;
  path: string;
  params: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
  headers: Record<string, string>;
  user?: unknown;
  ip: string;
  hostname: string;
  get(name: string): string | undefined;
  header(name: string): string | undefined;
}

/**
 * The response object interceptors and guards reach for. Nothing is written to a socket — a tool
 * call answers with the handler's return value — so this records headers and a status and no more.
 */
interface McpSyntheticResponse {
  statusCode: number;
  headersSent: boolean;
  locals: Record<string, unknown>;
  status(code: number): McpSyntheticResponse;
  setHeader(name: string, value: string): McpSyntheticResponse;
  getHeader(name: string): string | undefined;
  header(name: string, value: string): McpSyntheticResponse;
}

function readField(target: unknown, name: string): unknown {
  return typeof target === 'object' && target !== null ? Reflect.get(target, name) : undefined;
}

/** A whole request slot, or one named entry of it — `@Body()` vs `@Body('qty')`. */
function slotValue(input: { request: unknown; slot: string; key: unknown }): unknown {
  const container: unknown = readField(input.request, input.slot);
  if (typeof input.key !== 'string' || input.key.length === 0) {
    return container;
  }
  return readField(container, input.key);
}

/**
 * Maps each `@Body()` / `@Param()` / `@Query()` declaration to its value on the synthetic request.
 *
 * `ExternalContextCreator` calls this per parameter and then runs that parameter's pipes over the
 * result, so a `ParseIntPipe` or a `ValidationPipe` sees exactly what it would see on the wire.
 * `createParamDecorator` parameters never reach here: Nest runs their factory itself, against an
 * execution context built from the same request.
 */
const PARAMS_FACTORY: ParamsFactory = {
  exchangeKeyForValue(slot: number, key: unknown, args: unknown[]): unknown {
    const [request, response, next] = args;
    switch (slot) {
      case ROUTE_PARAM.request:
        return request;
      case ROUTE_PARAM.response:
        return response;
      case ROUTE_PARAM.next:
        return next;
      case ROUTE_PARAM.body:
        return slotValue({ request, slot: 'body', key });
      case ROUTE_PARAM.query:
        return slotValue({ request, slot: 'query', key });
      case ROUTE_PARAM.param:
        return slotValue({ request, slot: 'params', key });
      case ROUTE_PARAM.headers:
        return slotValue({
          request,
          slot: 'headers',
          key: typeof key === 'string' ? key.toLowerCase() : key,
        });
      case ROUTE_PARAM.host:
        return readField(request, 'hostname');
      case ROUTE_PARAM.ip:
        return readField(request, 'ip');
      default:
        return undefined;
    }
  },
};

function lowerCaseHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    result[name.toLowerCase()] = value;
  }
  return result;
}

/** `/orders/:id` + `{ id: '42' }` → `/orders/42`. */
function fillPath(input: { path: string; params: Record<string, string> }): string {
  return input.path.replace(/:([A-Za-z0-9_]+)/g, (placeholder: string, name: string) => {
    const value = input.params[name];
    return value === undefined ? placeholder : encodeURIComponent(value);
  });
}

function syntheticRequest(input: {
  route: McpRouteRef;
  args: McpRouteInput;
  principal: McpRoutePrincipal;
}): McpSyntheticRequest {
  const { route, args, principal } = input;
  const headers = lowerCaseHeaders(principal.headers);
  const path = fillPath({ path: route.path, params: args.params });
  const search = new URLSearchParams(args.query).toString();
  const url = search.length > 0 ? `${path}?${search}` : path;
  const get = (name: string): string | undefined => headers[name.toLowerCase()];
  return {
    method: route.method,
    url,
    originalUrl: url,
    baseUrl: '',
    path,
    params: args.params,
    query: args.query,
    body: args.hasBody ? args.body : {},
    headers,
    ...(principal.user !== undefined ? { user: principal.user } : {}),
    ip: '127.0.0.1',
    hostname: 'localhost',
    get,
    header: get,
  };
}

function syntheticResponse(): McpSyntheticResponse {
  const headers = new Map<string, string>();
  const response: McpSyntheticResponse = {
    statusCode: 200,
    headersSent: false,
    locals: {},
    status(code) {
      response.statusCode = code;
      return response;
    },
    setHeader(name, value) {
      headers.set(name.toLowerCase(), value);
      return response;
    },
    getHeader(name) {
      return headers.get(name.toLowerCase());
    },
    header(name, value) {
      return response.setHeader(name, value);
    },
  };
  return response;
}

/** The most specific message an `HttpException` carries — a `ValidationPipe` puts its own in the body. */
function reasonFor(exception: HttpException): string {
  const body: unknown = exception.getResponse();
  if (typeof body === 'string') {
    return body;
  }
  const message: unknown = readField(body, 'message');
  if (typeof message === 'string') {
    return message;
  }
  if (Array.isArray(message)) {
    const lines = message.filter((entry): entry is string => typeof entry === 'string');
    if (lines.length > 0) {
      return lines.join('; ');
    }
  }
  return exception.message;
}

function isMethod(value: unknown): value is (...args: unknown[]) => unknown {
  return typeof value === 'function';
}

/**
 * The same context creator, answering with the module the controller actually lives in.
 *
 * `ExternalContextCreator` works out which module a handler belongs to by looking for its class
 * among that module's PROVIDERS — which is right for the microservice and GraphQL handlers it was
 * built for, and wrong for a controller, because a controller is registered as a controller. The
 * lookup comes back empty, and `GuardsContextCreator` then resolves every class-based
 * `@UseGuards(SomeGuard)` to `null` and filters it out of the chain. The route would run with its
 * guards silently absent: exactly the failure this whole path exists to avoid.
 *
 * The discovery walk already knows the answer — the controller's `InstanceWrapper` names its host
 * module — so it is supplied instead of inferred. Everything else, including the shared metadata
 * cache and the resolved global guards, pipes and interceptors, is the injected instance's.
 */
function scopedToModule(input: {
  contexts: ExternalContextCreator;
  moduleKey: string;
}): ExternalContextCreator {
  const scoped: ExternalContextCreator = Object.create(input.contexts);
  scoped.getContextModuleKey = () => input.moduleKey;
  return scoped;
}

/** The `next()` a route handler is handed. Nothing follows a dispatched call, so it does nothing. */
function noop(): void {}

/**
 * Runs a route-derived tool call through the route's own request pipeline.
 *
 * It dispatches through `ExternalContextCreator` — the seam Nest itself uses to run a controller
 * method from a transport that is not HTTP — rather than calling the method. Calling the method
 * skips `@UseGuards`, the pipes and the interceptors, which is to say it skips the authorization the
 * route's author wrote, and that authorization is the whole reason the route was safe to expose.
 * Through this seam the guards run first, against an `ExecutionContext` whose
 * `switchToHttp().getRequest()` is the request below; then the param pipes and the app's global
 * ones; then the interceptors; then the handler.
 *
 * Two things a real request has are absent, deliberately:
 *
 * - **Middleware** (`configure(consumer)`) does not run. It is bound to the HTTP server's routing
 *   table, and there is no HTTP server in this path. Middleware parses, logs and sets CORS; in Nest,
 *   authorization is a guard, and guards do run.
 * - **Exception filters** do not run (`filters: false`). A filter exists to render an error into an
 *   HTTP response, and the response here is a tool result. Letting one run would hand it a response
 *   object nothing writes to a socket, and a global filter that answered `200` with an error body
 *   would turn a guard's refusal into a call that looks like it succeeded. The exception itself
 *   travels instead, so an `HttpException` reaches the caller with the status the route chose.
 */
@Injectable()
export class McpRouteDispatcher {
  constructor(private readonly contexts: ExternalContextCreator) {}

  compile(input: {
    instance: object;
    methodName: string;
    /** The controller's host module, whose injectable guards, pipes and interceptors apply. */
    moduleKey: string;
    route: McpRouteRef;
    principal: McpRoutePrincipalFactory;
  }): (args: McpRouteInput, actor: Actor) => Promise<unknown> {
    const { instance, methodName, moduleKey, route, principal } = input;
    const handler: unknown = Reflect.get(instance, methodName);
    if (!isMethod(handler)) {
      throw new Error(`${route.handler} is not a method, so it cannot be dispatched.`);
    }
    // Without a module key, `GuardsContextCreator` has nowhere to resolve a class-based
    // `@UseGuards` from and drops it — the route would run with its guards absent and nothing said.
    // Refusing here is the difference between a loud boot failure and an open door.
    if (moduleKey.length === 0) {
      throw new Error(
        `${route.handler} could not be traced to a module, so its guards, pipes and interceptors cannot be resolved. It is not exposed over MCP.`,
      );
    }
    const run = scopedToModule({ contexts: this.contexts, moduleKey }).create(
      instance,
      handler,
      methodName,
      ROUTE_ARGS_METADATA,
      PARAMS_FACTORY,
      undefined,
      undefined,
      { guards: true, interceptors: true, filters: false },
      'http',
    );
    return async (args, actor) => {
      const request = syntheticRequest({
        route,
        args,
        principal: principal({ actor, route }),
      });
      try {
        const result: unknown = await run(request, syntheticResponse(), noop);
        return result;
      } catch (error) {
        if (error instanceof HttpException) {
          throw new McpRouteHttpError(route.tool, error.getStatus(), reasonFor(error));
        }
        throw error;
      }
    };
  }
}
