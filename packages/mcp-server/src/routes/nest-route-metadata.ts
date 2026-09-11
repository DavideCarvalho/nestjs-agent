import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';

/**
 * The metadata keys Nest's HTTP decorators write, and the numeric tags `@Body()` / `@Param()` /
 * `@Query()` file their declarations under.
 *
 * Restated here rather than imported from `@nestjs/common/internal`, which only exists on Nest 12
 * while this package's peer range also covers 10 and 11. The values are a wire format shared with
 * `ExternalContextCreator`, which reads the same keys back.
 */
export const ROUTE_ARGS_METADATA = '__routeArguments__';
const PATH_METADATA = 'path';
const METHOD_METADATA = 'method';
const PARAMTYPES_METADATA = 'design:paramtypes';
/** `createParamDecorator` files its entries under a key containing this marker. */
const CUSTOM_ROUTE_ARGS_MARKER = '__customRouteArgs__';

/** Which slot of the request a handler parameter is bound to. Nest's `RouteParamtypes`. */
export const ROUTE_PARAM = {
  request: 0,
  response: 1,
  next: 2,
  body: 3,
  query: 4,
  param: 5,
  headers: 6,
  session: 7,
  file: 8,
  files: 9,
  host: 10,
  ip: 11,
  rawBody: 12,
} as const;

/** One `@Body()` / `@Param('id')` / `@CurrentUser()` declaration on a route handler. */
export interface RouteParamDeclaration {
  /**
   * One of {@link ROUTE_PARAM}, or `undefined` for a `createParamDecorator` parameter — those carry
   * a factory instead of a slot, and Nest runs it against the execution context.
   */
  slot: number | undefined;
  /** Position in the handler's parameter list. */
  index: number;
  /** The key the author narrowed the slot to — `'id'` in `@Param('id')`. `undefined` for `@Param()`. */
  key: string | undefined;
  /** The parameter's declared type, when the app compiles with `emitDecoratorMetadata`. */
  metatype: unknown;
}

/** An HTTP route as the metadata Nest already holds describes it. */
export interface NestRoute {
  /** The verb, uppercased — `'GET'`, `'POST'`. */
  method: string;
  /** The full path template, controller prefix included: `/orders/:id/lines`. */
  path: string;
  params: RouteParamDeclaration[];
}

const HTTP_METHOD_NAMES = new Map<number, string>([
  [RequestMethod.GET, 'GET'],
  [RequestMethod.POST, 'POST'],
  [RequestMethod.PUT, 'PUT'],
  [RequestMethod.DELETE, 'DELETE'],
  [RequestMethod.PATCH, 'PATCH'],
  [RequestMethod.OPTIONS, 'OPTIONS'],
  [RequestMethod.HEAD, 'HEAD'],
  [RequestMethod.SEARCH, 'SEARCH'],
]);

/**
 * The verb this handler answers, or `undefined` when it is not an HTTP route or answers more than
 * one verb (`@All()`) — a synthetic request has to carry one definite method.
 */
export function readRouteMethod(handler: object): string | undefined {
  const value: unknown = Reflect.getMetadata(METHOD_METADATA, handler);
  return typeof value === 'number' ? HTTP_METHOD_NAMES.get(value) : undefined;
}

/** The first path a `@Controller(...)` / `@Get(...)` declared; `undefined` when it declared none. */
function firstPath(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    const [head]: unknown[] = value;
    return typeof head === 'string' ? head : undefined;
  }
  return undefined;
}

/** Join a controller prefix and a handler path into one leading-slash template with no doubles. */
export function joinRoutePath(input: {
  prefix: string | undefined;
  suffix: string | undefined;
}): string {
  const segments = [input.prefix, input.suffix]
    .flatMap((part) => (part ?? '').split('/'))
    .filter((part) => part.length > 0);
  return `/${segments.join('/')}`;
}

/** The full path template for one route, controller prefix included. */
export function readRoutePath(input: { controller: object; handler: object }): string {
  return joinRoutePath({
    prefix: firstPath(Reflect.getMetadata(PATH_METADATA, input.controller)),
    suffix: firstPath(Reflect.getMetadata(PATH_METADATA, input.handler)),
  });
}

/** The `:name` placeholders in a path template, in the order they appear. */
export function pathParamNames(path: string): string[] {
  return [...path.matchAll(/:([A-Za-z0-9_]+)/g)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
}

/**
 * Nest keys each declaration `"<slot>:<index>"`, and a `createParamDecorator` one
 * `"<slot>__customRouteArgs__:<index>"`. Only the part before the colon identifies the slot.
 */
function slotOf(key: string): number | undefined {
  if (key.includes(CUSTOM_ROUTE_ARGS_MARKER)) {
    return undefined;
  }
  const [head] = key.split(':');
  const slot = Number(head);
  return Number.isInteger(slot) ? slot : undefined;
}

function indexOf(entry: unknown): number | undefined {
  if (typeof entry !== 'object' || entry === null) {
    return undefined;
  }
  const index: unknown = Reflect.get(entry, 'index');
  return typeof index === 'number' ? index : undefined;
}

function keyOf(entry: object): string | undefined {
  const data: unknown = Reflect.get(entry, 'data');
  return typeof data === 'string' ? data : undefined;
}

/**
 * Every parameter declaration on one route handler, in parameter order.
 *
 * This is the same metadata `ExternalContextCreator` reads when it runs the handler, so what the
 * input schema is derived from and what the pipes are applied to cannot drift apart.
 */
export function readRouteParams(input: {
  controller: object;
  methodName: string;
}): RouteParamDeclaration[] {
  const metadata: unknown = Reflect.getMetadata(
    ROUTE_ARGS_METADATA,
    input.controller,
    input.methodName,
  );
  if (typeof metadata !== 'object' || metadata === null) {
    return [];
  }
  const metatypes: unknown = Reflect.getMetadata(
    PARAMTYPES_METADATA,
    // `design:paramtypes` for a method lives on the PROTOTYPE, where the method does; the route
    // args above live on the constructor.
    Reflect.get(input.controller, 'prototype') ?? input.controller,
    input.methodName,
  );
  const declarations: RouteParamDeclaration[] = [];
  for (const [key, entry] of Object.entries(metadata)) {
    const index = indexOf(entry);
    if (index === undefined || typeof entry !== 'object' || entry === null) {
      continue;
    }
    declarations.push({
      slot: slotOf(key),
      index,
      key: keyOf(entry),
      metatype: Array.isArray(metatypes) ? metatypes[index] : undefined,
    });
  }
  return declarations.sort((left, right) => left.index - right.index);
}

/** The route, or `undefined` when this method is not an HTTP route with one definite verb. */
export function readNestRoute(input: {
  controller: object;
  handler: object;
  methodName: string;
}): NestRoute | undefined {
  const method = readRouteMethod(input.handler);
  if (method === undefined) {
    return undefined;
  }
  return {
    method,
    path: readRoutePath({ controller: input.controller, handler: input.handler }),
    params: readRouteParams({ controller: input.controller, methodName: input.methodName }),
  };
}
