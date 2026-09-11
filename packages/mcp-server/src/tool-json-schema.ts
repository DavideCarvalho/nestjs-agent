import type { AnyObjectSchema } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { StandardSchemaV1 } from '@standard-schema/spec';

/** The JSON Schema an MCP client receives as a tool's `inputSchema`. */
export type McpInputSchema = Tool['inputSchema'];

/** A schema an MCP client can call with anything; the registry still validates the real one. */
const PERMISSIVE: McpInputSchema = { type: 'object', properties: {}, additionalProperties: true };

/**
 * True for a Zod schema, which tags its Standard Schema props with `vendor: 'zod'`. Narrows to the
 * SDK's `AnyObjectSchema` so its converter can consume it without a cast.
 */
function isZodSchema(schema: StandardSchemaV1): schema is StandardSchemaV1 & AnyObjectSchema {
  return schema['~standard'].vendor === 'zod';
}

/** True when the schema carries the Standard JSON Schema extension (`~standard.jsonSchema.input`). */
function hasStandardJsonSchema(schema: StandardSchemaV1): schema is StandardSchemaV1 & {
  '~standard': { jsonSchema: { input(): object } };
} {
  const standard = schema['~standard'];
  if (!('jsonSchema' in standard)) {
    return false;
  }
  const converter = standard.jsonSchema;
  return (
    typeof converter === 'object' &&
    converter !== null &&
    'input' in converter &&
    typeof converter.input === 'function'
  );
}

function isPropertyMap(value: unknown): value is Record<string, object> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((entry) => typeof entry === 'object' && entry !== null);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

/**
 * Re-shape a converted JSON Schema into MCP's tool-input shape: `type: 'object'` is fixed by the
 * protocol, `properties` and `required` are only carried through when they have the declared shape,
 * and every other keyword (`$defs`, `additionalProperties`, `description`, …) rides along untouched
 * so a nested reference still resolves on the client.
 */
function asMcpInputSchema(converted: Record<string, unknown>): McpInputSchema {
  const schema: McpInputSchema = { type: 'object' };
  for (const [keyword, value] of Object.entries(converted)) {
    if (keyword === 'type') continue;
    if (keyword === 'properties') {
      if (isPropertyMap(value)) schema.properties = value;
      continue;
    }
    if (keyword === 'required') {
      if (isStringArray(value)) schema.required = value;
      continue;
    }
    schema[keyword] = value;
  }
  return schema;
}

/**
 * Convert a tool's `StandardSchemaV1` into the JSON Schema `tools/list` advertises.
 *
 * Zod schemas go through the SDK's own converter (which handles Zod 3 and 4); schemas carrying the
 * Standard JSON Schema extension (Valibot, ArkType, Zod 4) hand their `input()` schema over. Anything
 * else degrades to a permissive object — the client loses the parameter shapes, and nothing else:
 * `ToolRegistry.invoke` validates the real schema before the handler runs, so a call that does not
 * fit it is refused whatever the client was told.
 */
export function toMcpInputSchema(schema: StandardSchemaV1): McpInputSchema {
  if (isZodSchema(schema)) {
    return asMcpInputSchema(toJsonSchemaCompat(schema));
  }
  if (hasStandardJsonSchema(schema)) {
    const converted: object = schema['~standard'].jsonSchema.input();
    return asMcpInputSchema({ ...converted });
  }
  return PERMISSIVE;
}
