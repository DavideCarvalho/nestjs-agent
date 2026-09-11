import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { McpInputSchema } from '../tool-json-schema.js';
import { type NestRoute, ROUTE_PARAM, pathParamNames } from './nest-route-metadata.js';

/** The arguments an MCP client sends for a route-derived tool, mirroring the request's own slots. */
export interface McpRouteInput {
  /** Path placeholders: `{ id: '42' }` for `/orders/:id`. */
  params: Record<string, string>;
  /** Query string, already string-valued as the wire would deliver it. */
  query: Record<string, string>;
  /** The request body, untouched — it travels as JSON on the wire and arrives as JSON here. */
  body: unknown;
  /** Whether the route declared a body at all; a route with none is dispatched without one. */
  hasBody: boolean;
}

/** One JSON Schema object describing a single request slot. */
interface SlotSchema {
  type: 'object';
  properties?: Record<string, object>;
  required?: string[];
  additionalProperties?: boolean;
  description?: string;
}

/** What the route declared, reduced to the three slots an MCP caller can fill. */
interface RouteSlots {
  params: SlotSchema | undefined;
  query: SlotSchema | undefined;
  body: object | undefined;
  /** Path placeholders a caller must supply. */
  requiredParams: string[];
  /** Whether the body slot exists at all. */
  hasBody: boolean;
}

function typeNameOf(metatype: unknown): string | undefined {
  if (typeof metatype !== 'function') {
    return undefined;
  }
  const name: unknown = Reflect.get(metatype, 'name');
  return typeof name === 'string' && name.length > 0 ? name : undefined;
}

/**
 * The JSON Schema for one scalar parameter, from its declared TypeScript type. Anything that is not
 * a primitive is advertised as a string: that is what the slot carries on the wire, whatever the
 * route's pipes turn it into afterwards.
 */
function scalarSchema(metatype: unknown): object {
  if (metatype === Number) {
    return { type: 'number' };
  }
  if (metatype === Boolean) {
    return { type: 'boolean' };
  }
  return { type: 'string' };
}

function slotOrUndefined(input: {
  properties: Record<string, object>;
  required: string[];
  open: boolean;
  description: string | undefined;
}): SlotSchema | undefined {
  const { properties, required, open, description } = input;
  if (Object.keys(properties).length === 0 && !open) {
    return undefined;
  }
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: open,
    ...(description !== undefined ? { description } : {}),
  };
}

/**
 * Read one route's slots off its parameter declarations.
 *
 * Three things are derived exactly, because the route states them outright: which path placeholders
 * exist, which query keys an author named, and which body keys an author named. A whole-object
 * `@Body() dto: CreateOrderDto` is the one that cannot be: the DTO's fields are erased by the time
 * the app runs, and only its constructor survives. That slot is advertised as an open object named
 * after the DTO, and the route's own `ValidationPipe` still judges what arrives in it.
 */
function readSlots(route: NestRoute): RouteSlots {
  const paramProperties: Record<string, object> = {};
  const queryProperties: Record<string, object> = {};
  const bodyProperties: Record<string, object> = {};
  const requiredParams: string[] = [];
  const requiredBody: string[] = [];
  let openQuery = false;
  let hasBody = false;
  let bodyTypeName: string | undefined;
  let wholeBody = false;

  for (const declaration of route.params) {
    const { slot, key, metatype } = declaration;
    if (slot === ROUTE_PARAM.param) {
      for (const name of key === undefined ? pathParamNames(route.path) : [key]) {
        // Always a string: a path segment is text until a pipe says otherwise.
        paramProperties[name] = { type: 'string' };
        requiredParams.push(name);
      }
      continue;
    }
    if (slot === ROUTE_PARAM.query) {
      if (key === undefined) {
        openQuery = true;
        continue;
      }
      queryProperties[key] = scalarSchema(metatype);
      continue;
    }
    if (slot === ROUTE_PARAM.body) {
      hasBody = true;
      if (key === undefined) {
        wholeBody = true;
        bodyTypeName = typeNameOf(metatype);
        continue;
      }
      bodyProperties[key] = scalarSchema(metatype);
      requiredBody.push(key);
    }
  }

  const body = wholeBody
    ? {
        type: 'object',
        additionalProperties: true,
        description:
          bodyTypeName === undefined || bodyTypeName === 'Object'
            ? 'The request body this route declares. Its fields are validated by the route itself.'
            : `A ${bodyTypeName}. Its fields are validated by the route itself.`,
      }
    : slotOrUndefined({
        properties: bodyProperties,
        required: requiredBody,
        open: false,
        description: undefined,
      });

  return {
    params: slotOrUndefined({
      properties: paramProperties,
      required: requiredParams,
      open: false,
      description: undefined,
    }),
    query: slotOrUndefined({
      properties: queryProperties,
      required: [],
      open: openQuery,
      description: undefined,
    }),
    body,
    requiredParams,
    hasBody,
  };
}

function jsonSchemaFor(slots: RouteSlots): McpInputSchema {
  const properties: Record<string, object> = {};
  const required: string[] = [];
  if (slots.params !== undefined) {
    properties.params = slots.params;
    if (slots.requiredParams.length > 0) {
      required.push('params');
    }
  }
  if (slots.query !== undefined) {
    properties.query = slots.query;
  }
  if (slots.body !== undefined) {
    properties.body = slots.body;
    required.push('body');
  }
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}

function issue(message: string): StandardSchemaV1.Result<McpRouteInput> {
  return { issues: [{ message }] };
}

/** A scalar as the wire would deliver it. Path and query values are text in a real request. */
function asWireString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return undefined;
}

function readSlot(value: object, name: string): unknown {
  return Reflect.get(value, name);
}

function stringRecord(input: {
  value: unknown;
  slot: string;
}): Record<string, string> | { issues: readonly StandardSchemaV1.Issue[] } {
  if (input.value === undefined) {
    return {};
  }
  if (typeof input.value !== 'object' || input.value === null || Array.isArray(input.value)) {
    return { issues: [{ message: `"${input.slot}" must be an object of named values.` }] };
  }
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(input.value)) {
    const text = asWireString(entry);
    if (text === undefined) {
      return {
        issues: [
          {
            message: `"${input.slot}.${key}" must be a string, number or boolean — a request carries it as text.`,
          },
        ],
      };
    }
    result[key] = text;
  }
  return result;
}

function hasIssues(
  value: Record<string, string> | { issues: readonly StandardSchemaV1.Issue[] },
): value is { issues: readonly StandardSchemaV1.Issue[] } {
  return 'issues' in value;
}

const SLOT_NAMES = ['params', 'query', 'body'];

function validateSlots(source: object, slots: RouteSlots): StandardSchemaV1.Result<McpRouteInput> {
  const unknownKey = Object.keys(source).find((key) => !SLOT_NAMES.includes(key));
  if (unknownKey !== undefined) {
    return issue(
      `"${unknownKey}" is not a slot of this request. Arguments go under "params", "query" and "body".`,
    );
  }
  const params = stringRecord({ value: readSlot(source, 'params'), slot: 'params' });
  if (hasIssues(params)) {
    return params;
  }
  const missing = slots.requiredParams.find((name) => params[name] === undefined);
  if (missing !== undefined) {
    return issue(`"params.${missing}" is required by this route's path.`);
  }
  const query = stringRecord({ value: readSlot(source, 'query'), slot: 'query' });
  if (hasIssues(query)) {
    return query;
  }
  const body = readSlot(source, 'body');
  if (slots.hasBody && body === undefined) {
    return issue('"body" is required by this route.');
  }
  return { value: { params, query, body, hasBody: slots.hasBody } };
}

/** A Standard Schema carrying the JSON Schema `tools/list` advertises for it. */
export interface RouteStandardSchema extends StandardSchemaV1<unknown, McpRouteInput> {
  '~standard': StandardSchemaV1.Props<unknown, McpRouteInput> & {
    jsonSchema: { input(): McpInputSchema };
  };
}

/**
 * The input schema for one route-derived tool.
 *
 * A Standard Schema, so the tool is an ordinary `ToolSpec` that `ToolRegistry` validates and the
 * `RolesPolicy` gates like any other. It carries its JSON Schema through the Standard JSON Schema
 * extension, which `toMcpInputSchema` already reads — so the document a client is shown and the
 * shape the registry enforces are built from the same slots.
 *
 * What it enforces is what a request would: the three slots and nothing else, every path
 * placeholder present, and path and query values reduced to the text an HTTP request delivers. The
 * route's own pipes then judge everything that has a judgement to make.
 */
export function routeInputSchema(route: NestRoute): RouteStandardSchema {
  const slots = readSlots(route);
  const jsonSchema = jsonSchemaFor(slots);
  return {
    '~standard': {
      version: 1,
      vendor: 'nestjs-agent-mcp-server',
      validate: (value) => {
        if (value === undefined || value === null) {
          return validateSlots({}, slots);
        }
        if (typeof value !== 'object' || Array.isArray(value)) {
          return issue('Arguments must be an object with "params", "query" and "body" slots.');
        }
        return validateSlots(value, slots);
      },
      jsonSchema: { input: () => jsonSchema },
    },
  };
}
