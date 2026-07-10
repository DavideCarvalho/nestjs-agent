import type { ModelMessage, SinkWriter, ToolDefinition } from '@dudousxd/nestjs-agent-core';
import type { StandardJSONSchemaV1, StandardSchemaV1 } from '@standard-schema/spec';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { aiSdkModel } from './ai-sdk-model.js';

const { streamTextMock } = vi.hoisted(() => ({ streamTextMock: vi.fn() }));

// Mock the SDK boundary: `tool`/`jsonSchema` are identity-ish so we can inspect what got passed,
// and `streamText` is a spy whose return value each test controls.
vi.mock('ai', () => ({
  streamText: (args: unknown) => streamTextMock(args),
  tool: (definition: unknown) => definition,
  jsonSchema: (schema: unknown) => ({ jsonSchema: schema }),
}));

interface CollectingSink extends SinkWriter {
  readonly written: string;
}

function createSink(): CollectingSink {
  const decoder = new TextDecoder();
  let written = '';
  return {
    write(chunk: Uint8Array) {
      written += decoder.decode(chunk);
    },
    end() {},
    get written() {
      return written;
    },
  };
}

function noJsonSchemaTool(name: string): ToolDefinition {
  const inputSchema: StandardSchemaV1 = {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate: (value: unknown) => ({ value }),
    },
  };
  return { name, kind: 'read', description: `${name} tool`, inputSchema };
}

// AI SDK v7 moved `response`/`providerMetadata` off the top-level result onto the final step
// (a promise). This mirrors that shape so the adapter reads `modelId`/cost from `finalStep`.
function fakeFinalStep(providerMetadata: unknown) {
  return Promise.resolve({
    response: { modelId: 'openai/gpt-4o', id: 'resp-1', timestamp: new Date() },
    providerMetadata,
  });
}

function fakeStreamResult(overrides: Record<string, unknown> = {}) {
  return {
    stream: (async function* generate() {
      yield { type: 'text-delta', id: '1', text: 'Hel' };
      yield { type: 'reasoning-delta', id: 'r', text: 'thinking' };
      yield { type: 'text-delta', id: '1', text: 'lo' };
      yield { type: 'tool-call', toolCallId: 'call-1', toolName: 'search', input: { q: 'x' } };
    })(),
    toolCalls: Promise.resolve([{ toolCallId: 'call-1', toolName: 'search', input: { q: 'x' } }]),
    usage: Promise.resolve({
      inputTokens: 10,
      outputTokens: 5,
      inputTokenDetails: { cacheReadTokens: 4, cacheWriteTokens: 2 },
      outputTokenDetails: { reasoningTokens: 3 },
    }),
    finalStep: fakeFinalStep({ gateway: { cost: 0.0123 } }),
    ...overrides,
  };
}

describe('aiSdkModel', () => {
  beforeEach(() => {
    streamTextMock.mockReset();
    streamTextMock.mockReturnValue(fakeStreamResult());
  });

  it('streams text deltas to the sink in order and accumulates the final text', async () => {
    const sink = createSink();
    const model = aiSdkModel('openai/gpt-4o');

    const result = await model.runTurn({
      system: 'you are helpful',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      sink,
    });

    // The sink carries NDJSON AgentStreamEvents. Text deltas arrive in stream order as `text` events
    // and accumulate to the final text; reasoning + the tool call ride the same stream.
    const events = sink.written
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line): unknown => JSON.parse(line));
    const textDeltas = events
      .filter(
        (event): event is { kind: 'text'; text: string } =>
          typeof event === 'object' && event !== null && (event as { kind?: unknown }).kind === 'text',
      )
      .map((event) => event.text);
    expect(textDeltas.join('')).toBe('Hello');
    expect(events).toContainEqual({ kind: 'reasoning', text: 'thinking' });
    expect(result.text).toBe('Hello');
  });

  it('maps SDK tool calls to ToolCallRequest', async () => {
    const result = await aiSdkModel('openai/gpt-4o').runTurn({
      system: '',
      messages: [],
      tools: [],
      sink: createSink(),
    });

    expect(result.toolCalls).toEqual([{ id: 'call-1', name: 'search', input: { q: 'x' } }]);
  });

  it('maps SDK usage to MessageUsage including cache and reasoning breakdowns', async () => {
    const result = await aiSdkModel('openai/gpt-4o').runTurn({
      system: '',
      messages: [],
      tools: [],
      sink: createSink(),
    });

    expect(result.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 4,
      cacheWriteTokens: 2,
      reasoningTokens: 3,
    });
  });

  it('surfaces a gateway-reported cost as costUsd and the response modelId', async () => {
    const result = await aiSdkModel('openai/gpt-4o').runTurn({
      system: '',
      messages: [],
      tools: [],
      sink: createSink(),
    });

    expect(result.costUsd).toBe(0.0123);
    expect(result.modelId).toBe('openai/gpt-4o');
  });

  it('reads OpenRouter total_cost when there is no gateway cost', async () => {
    streamTextMock.mockReturnValue(
      fakeStreamResult({ finalStep: fakeFinalStep({ openrouter: { total_cost: 0.5 } }) }),
    );

    const result = await aiSdkModel('openrouter/anthropic/claude').runTurn({
      system: '',
      messages: [],
      tools: [],
      sink: createSink(),
    });

    expect(result.costUsd).toBe(0.5);
  });

  it('omits costUsd when the provider reports no gateway/OpenRouter cost', async () => {
    streamTextMock.mockReturnValue(fakeStreamResult({ finalStep: fakeFinalStep(undefined) }));

    const result = await aiSdkModel('anthropic/claude').runTurn({
      system: '',
      messages: [],
      tools: [],
      sink: createSink(),
    });

    expect(result.costUsd).toBeUndefined();
    expect('costUsd' in result).toBe(false);
  });

  it('passes tools to the SDK WITHOUT an execute function', async () => {
    await aiSdkModel('openai/gpt-4o').runTurn({
      system: '',
      messages: [],
      tools: [noJsonSchemaTool('search')],
      sink: createSink(),
    });

    const call = streamTextMock.mock.calls[0]?.[0];
    expect(call.tools.search).toBeDefined();
    expect('execute' in call.tools.search).toBe(false);
    expect(call.tools.search.description).toBe('search tool');
  });

  it('maps assistant tool-calls and tool-results into SDK messages', async () => {
    const messages: ModelMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'ask' },
      {
        role: 'assistant',
        content: 'let me check',
        toolCalls: [{ id: 'c1', name: 'search', input: { q: 'x' } }],
        toolResults: [{ id: 'c1', name: 'search', output: { hits: 2 } }],
      },
    ];

    await aiSdkModel('openai/gpt-4o').runTurn({
      system: '',
      messages,
      tools: [],
      sink: createSink(),
    });

    const passed = streamTextMock.mock.calls[0]?.[0].messages;
    expect(passed).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'ask' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'let me check' },
          { type: 'tool-call', toolCallId: 'c1', toolName: 'search', input: { q: 'x' } },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'c1',
            toolName: 'search',
            output: { type: 'text', value: '{"hits":2}' },
          },
        ],
      },
    ]);
  });

  it('maps a user message with attachments into image/file content parts', async () => {
    const messages: ModelMessage[] = [
      {
        role: 'user',
        content: 'what is in these?',
        attachments: [
          { mediaId: 'm1', url: 'https://cdn/a.png', contentType: 'image/png', name: 'a.png' },
          { mediaId: 'm2', url: 'https://cdn/b.pdf', contentType: 'application/pdf', name: 'b.pdf' },
        ],
      },
    ];

    await aiSdkModel('openai/gpt-4o').runTurn({
      system: '',
      messages,
      tools: [],
      sink: createSink(),
    });

    const passed = streamTextMock.mock.calls[0]?.[0].messages;
    expect(passed).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is in these?' },
          { type: 'image', image: new URL('https://cdn/a.png'), mediaType: 'image/png' },
          {
            type: 'file',
            data: new URL('https://cdn/b.pdf'),
            mediaType: 'application/pdf',
            filename: 'b.pdf',
          },
        ],
      },
    ]);
  });

  it('leaves a user message with no attachments as a plain string', async () => {
    await aiSdkModel('openai/gpt-4o').runTurn({
      system: '',
      messages: [{ role: 'user', content: 'plain', attachments: [] }],
      tools: [],
      sink: createSink(),
    });

    const passed = streamTextMock.mock.calls[0]?.[0].messages;
    expect(passed).toEqual([{ role: 'user', content: 'plain' }]);
  });

  it('passes a Standard Schema through directly when it carries the JSON Schema converter', async () => {
    const inputSchema: StandardSchemaV1 & StandardJSONSchemaV1 = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: (value: unknown) => ({ value }),
        jsonSchema: {
          input: () => ({ type: 'object', properties: {} }),
          output: () => ({ type: 'object', properties: {} }),
        },
      },
    };
    const converterSchema: ToolDefinition = {
      name: 'lookup',
      kind: 'read',
      description: 'lookup tool',
      inputSchema,
    };

    await aiSdkModel('openai/gpt-4o').runTurn({
      system: '',
      messages: [],
      tools: [converterSchema],
      sink: createSink(),
    });

    const call = streamTextMock.mock.calls[0]?.[0];
    // Pass-through: the SDK receives the original standard schema, not a jsonSchema() wrapper.
    expect(call.tools.lookup.inputSchema).toBe(converterSchema.inputSchema);
  });
});
