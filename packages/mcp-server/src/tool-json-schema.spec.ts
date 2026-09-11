import type { StandardSchemaV1 } from '@standard-schema/spec';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { toMcpInputSchema } from './tool-json-schema.js';

/** A Standard Schema from a vendor the SDK cannot introspect, with no JSON Schema extension. */
const opaque: StandardSchemaV1 = {
  '~standard': {
    version: 1,
    vendor: 'handwritten',
    validate: (value) => ({ value }),
  },
};

/** A Standard Schema carrying the JSON Schema extension (what Valibot / ArkType / Zod 4 expose). */
const withJsonSchema: StandardSchemaV1 & {
  '~standard': { jsonSchema: { input(): object } };
} = {
  '~standard': {
    version: 1,
    vendor: 'valibot-like',
    validate: (value) => ({ value }),
    jsonSchema: {
      input: () => ({
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
      }),
    },
  },
};

describe('toMcpInputSchema', () => {
  it('converts a Zod object into the parameter shapes a client can fill in', () => {
    const schema = toMcpInputSchema(z.object({ city: z.string(), limit: z.number().optional() }));
    expect(schema.type).toBe('object');
    expect(schema.properties).toMatchObject({
      city: { type: 'string' },
      limit: { type: 'number' },
    });
    expect(schema.required).toEqual(['city']);
  });

  it('carries the converter’s other keywords through, so nested references still resolve', () => {
    const schema = toMcpInputSchema(z.object({ city: z.string() }));
    expect(schema.additionalProperties).toBe(false);
  });

  it('hands a Standard JSON Schema straight through', () => {
    const schema = toMcpInputSchema(withJsonSchema);
    expect(schema.properties).toEqual({ city: { type: 'string' } });
    expect(schema.required).toEqual(['city']);
  });

  it('degrades an unintrospectable schema to a permissive object rather than failing the list', () => {
    // The client loses the parameter shapes and nothing else: `ToolRegistry.invoke` validates the
    // real schema before the handler runs.
    expect(toMcpInputSchema(opaque)).toEqual({
      type: 'object',
      properties: {},
      additionalProperties: true,
    });
  });
});
