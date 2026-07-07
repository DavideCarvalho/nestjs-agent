import type { SinkWriter, ToolDefinition } from '@dudousxd/nestjs-agent-core';
import type { StandardJSONSchemaV1, StandardSchemaV1 } from '@standard-schema/spec';
import type { JSONSchema7 } from 'ai';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { aiSdkModel } from './ai-sdk-model.js';

// A genuine end-to-end run: no mocking of the `ai` module. We drive the real `streamText` with a
// mock model that records exactly the tool JSON schema the SDK derived from each tool's Standard
// Schema — the thing the real model would see. This proves a real Zod schema reaches the model as
// its true parameter shapes rather than being flattened to a permissive object.

function createSink(): SinkWriter {
  return { write() {}, end() {} };
}

function recordingModel(): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: '1' },
          { type: 'text-delta', id: '1', delta: 'ok' },
          { type: 'text-end', id: '1' },
          {
            type: 'finish',
            finishReason: 'stop',
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          },
        ],
      }),
    }),
  });
}

/** The JSON schema the SDK handed the model for `toolName`, dug out of the recorded call. */
function schemaSeenByModel(model: MockLanguageModelV3, toolName: string): JSONSchema7 {
  const tools = model.doStreamCalls[0]?.tools ?? [];
  const match = tools.find((entry) => entry.type === 'function' && entry.name === toolName);
  if (!match || match.type !== 'function') {
    throw new Error(`tool ${toolName} was not passed to the model`);
  }
  return match.inputSchema;
}

async function runWith(tools: ToolDefinition[]): Promise<MockLanguageModelV3> {
  const model = recordingModel();
  await aiSdkModel(model).runTurn({
    system: '',
    messages: [{ role: 'user', content: 'go' }],
    tools,
    sink: createSink(),
  });
  return model;
}

describe('aiSdkModel — Standard Schema → model params (real SDK)', () => {
  it('derives the real parameter shapes from a Zod tool schema', async () => {
    const tool: ToolDefinition = {
      name: 'getWeather',
      kind: 'read',
      description: 'weather',
      inputSchema: z.object({ city: z.string(), units: z.enum(['c', 'f']).optional() }),
    };

    const schema = schemaSeenByModel(await runWith([tool]), 'getWeather');

    // The model sees the true shape — not the permissive `{ additionalProperties: true }` fallback.
    expect(schema.type).toBe('object');
    expect(schema.properties).toMatchObject({
      city: { type: 'string' },
      units: { type: 'string', enum: ['c', 'f'] },
    });
    expect(schema.required).toEqual(['city']);
  });

  it('derives real shapes from a schema that implements the Standard JSON Schema extension', async () => {
    const inputSchema: StandardSchemaV1 & StandardJSONSchemaV1 = {
      '~standard': {
        version: 1,
        vendor: 'valibot-like',
        validate: (value: unknown) => ({ value }),
        // The camelCase `jsonSchema` converter the spec (and the SDK) actually read.
        jsonSchema: {
          input: () => ({
            type: 'object',
            properties: { key: { type: 'string' } },
            required: ['key'],
          }),
          output: () => ({ type: 'object', properties: { key: { type: 'string' } } }),
        },
      },
    };
    const tool: ToolDefinition = {
      name: 'lookup',
      kind: 'read',
      description: 'lookup',
      inputSchema,
    };

    const schema = schemaSeenByModel(await runWith([tool]), 'lookup');

    expect(schema.properties).toMatchObject({ key: { type: 'string' } });
    expect(schema.required).toEqual(['key']);
  });

  it('degrades a bare Standard Schema (no vendor, no extension) to a permissive object', async () => {
    const inputSchema: StandardSchemaV1 = {
      '~standard': { version: 1, vendor: 'custom', validate: (value: unknown) => ({ value }) },
    };
    const tool: ToolDefinition = { name: 'bare', kind: 'read', description: 'bare', inputSchema };

    const schema = schemaSeenByModel(await runWith([tool]), 'bare');

    // No throw, and the SDK receives a valid (if shapeless) object schema; the agent loop still
    // validates input against the real Standard Schema before running the tool.
    expect(schema).toMatchObject({ type: 'object', additionalProperties: true });
  });
});
