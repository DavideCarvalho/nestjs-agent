import { schemaExtensionOf } from '@dudousxd/nestjs-agent-core';
import type { StandardSchemaV1 } from '@standard-schema/spec';

/** The JSON Schema an MCP client receives as a tool's `inputSchema`: always an object. */
export interface McpInputSchema {
  type: 'object';
  properties?: Record<string, object>;
  required?: string[];
  [keyword: string]: unknown;
}

/** A schema an MCP client can call with anything; the registry still validates the real one. */
const PERMISSIVE: McpInputSchema = { type: 'object', properties: {}, additionalProperties: true };

/** True when the schema carries the Standard JSON Schema extension (`~standard.jsonSchema.input`). */
function hasStandardJsonSchema(schema: StandardSchemaV1): schema is StandardSchemaV1 & {
  '~standard': { jsonSchema: { input(options: { target: string }): object } };
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
 * A schema carrying the Standard JSON Schema extension (Zod 4, ArkType, Valibot with
 * `toStandardJsonSchema`) hands its `input()` schema over. Anything else (Zod 3) degrades to a
 * permissive object — the client loses the parameter shapes, and nothing else:
 * `ToolRegistry.invoke` validates the real schema before the handler runs, so a call that does not
 * fit it is refused whatever the client was told.
 */
export function toMcpInputSchema(schema: StandardSchemaV1): McpInputSchema {
  // Another schema plus a few properties (`withConfirmFields`): describe the inner one, add them.
  const extension = schemaExtensionOf(schema);
  if (extension !== undefined) {
    const base = toMcpInputSchema(extension.base);
    return asMcpInputSchema({
      ...base,
      properties: { ...(base.properties ?? {}), ...extension.properties },
    });
  }
  if (hasStandardJsonSchema(schema)) {
    const converted: object = schema['~standard'].jsonSchema.input({ target: 'draft-2020-12' });
    return asMcpInputSchema({ ...converted });
  }
  return PERMISSIVE;
}
