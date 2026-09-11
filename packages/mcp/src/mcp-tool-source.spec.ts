import type { AiToolCtx } from '@dudousxd/nestjs-agent-core';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  type CallToolRequest,
  CallToolRequestSchema,
  type CallToolResult,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { McpToolSource } from './mcp-tool-source.js';
import { isTransientMcpError } from './mcp-transient.js';

const CTX: AiToolCtx = {
  actor: { id: 'u-1', roles: ['ADMIN'] },
  threadId: 't-1',
  runId: 'r-1',
  requestId: 'r-1',
};

const weatherTool: Tool = {
  name: 'get_weather',
  description: 'Current weather for a city.',
  inputSchema: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
    additionalProperties: false,
  },
};

type CallHandler = (
  params: CallToolRequest['params'],
  serverTransport: Transport,
) => Promise<CallToolResult>;

const sources: McpToolSource[] = [];

/** A linked-pair transport factory that builds a FRESH server per connect — a reconnect gets a new one. */
function linkedTransport(
  tools: Tool[],
  call: CallHandler,
  onConnect?: () => void,
): () => Promise<Transport> {
  return async () => {
    onConnect?.();
    const server = new Server({ name: 'fake', version: '1.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, () => Promise.resolve({ tools }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    server.setRequestHandler(CallToolRequestSchema, (request) =>
      call(request.params, serverTransport),
    );
    await server.connect(serverTransport);
    return clientTransport;
  };
}

const okCall: CallHandler = (params) =>
  Promise.resolve({
    content: [{ type: 'text', text: `sunny in ${String(params.arguments?.city)}` }],
  });

function source(
  overrides: Partial<ConstructorParameters<typeof McpToolSource>[0]> & {
    create: () => Promise<Transport>;
  },
  logger?: { warn: (message: string) => void },
): McpToolSource {
  const { create, ...config } = overrides;
  const instance = new McpToolSource(
    { name: 'weather', transport: { type: 'custom', create }, ...config },
    logger,
  );
  sources.push(instance);
  return instance;
}

afterEach(async () => {
  await Promise.all(sources.splice(0).map((instance) => instance.close()));
});

describe('McpToolSource.import', () => {
  it("maps the server's tools onto namespaced, HITL-gated specs with a real input schema", async () => {
    const tools = await source({ create: linkedTransport([weatherTool], okCall) }).import();

    expect(tools).toHaveLength(1);
    const spec = tools[0]?.spec;
    expect(spec?.name).toBe('weather_get_weather');
    expect(spec?.description).toBe('Current weather for a city.');
    expect(spec?.kind).toBe('action');
    expect(await spec?.inputSchema['~standard'].validate({ city: 'Lisbon' })).toEqual({
      value: { city: 'Lisbon' },
    });
    expect((await spec?.inputSchema['~standard'].validate({}))?.issues).toBeDefined();
  });

  it('carries the per-server authorization settings onto every imported spec', async () => {
    const tools = await source({
      create: linkedTransport([weatherTool], okCall),
      roles: ['OPS'],
      ability: 'weather.read',
      enabled: false,
    }).import();

    expect(tools[0]?.spec.roles).toEqual(['OPS']);
    expect(tools[0]?.spec.ability).toBe('weather.read');
    expect(tools[0]?.spec.enabled).toBe(false);
  });

  it('imports only the tools an include/exclude list selects', async () => {
    const second: Tool = { ...weatherTool, name: 'set_thermostat' };
    const included = await source({
      create: linkedTransport([weatherTool, second], okCall),
      include: ['get_weather'],
    }).import();
    const excluded = await source({
      create: linkedTransport([weatherTool, second], okCall),
      exclude: ['set_thermostat'],
    }).import();

    expect(included.map((tool) => tool.remoteName)).toEqual(['get_weather']);
    expect(excluded.map((tool) => tool.remoteName)).toEqual(['get_weather']);
  });

  it('skips a tool whose schema cannot be compiled instead of importing an unvalidated one', async () => {
    const warnings: string[] = [];
    const broken: Tool = {
      name: 'broken',
      inputSchema: { type: 'object', properties: { a: { $ref: '#/definitions/missing' } } },
    };

    const tools = await source(
      { create: linkedTransport([broken, weatherTool], okCall) },
      { warn: (message) => warnings.push(message) },
    ).import();

    expect(tools.map((tool) => tool.remoteName)).toEqual(['get_weather']);
    expect(warnings.join('\n')).toContain('broken');
  });

  it('skips a tool whose input pattern would let the server stall the process that validates it', async () => {
    const warnings: string[] = [];
    const poisoned: Tool = {
      name: 'poisoned',
      inputSchema: { type: 'object', properties: { s: { type: 'string', pattern: '(a+)+$' } } },
    };

    const tools = await source(
      { create: linkedTransport([poisoned, weatherTool], okCall) },
      { warn: (message) => warnings.push(message) },
    ).import();

    expect(tools.map((tool) => tool.remoteName)).toEqual(['get_weather']);
    expect(warnings.join('\n')).toContain('poisoned');
  });
});

describe('McpToolSource tool calls', () => {
  it('returns a single text result as plain text', async () => {
    const [tool] = await source({ create: linkedTransport([weatherTool], okCall) }).import();

    expect(await tool?.handler.execute({ city: 'Lisbon' }, CTX)).toBe('sunny in Lisbon');
  });

  it('prefers the structured result when the server sends one', async () => {
    const [tool] = await source({
      create: linkedTransport([weatherTool], () =>
        Promise.resolve({
          content: [{ type: 'text', text: '{"tempC":21}' }],
          structuredContent: { tempC: 21 },
        }),
      ),
    }).import();

    expect(await tool?.handler.execute({ city: 'Lisbon' }, CTX)).toEqual({ tempC: 21 });
  });

  it("throws the server's message when the tool reports isError, so the turn records a failed call", async () => {
    const [tool] = await source({
      create: linkedTransport([weatherTool], () =>
        Promise.resolve({ content: [{ type: 'text', text: 'no such city' }], isError: true }),
      ),
    }).import();

    await expect(tool?.handler.execute({ city: 'Atlantis' }, CTX)).rejects.toThrow('no such city');
  });

  it('gives up on a server that never answers instead of holding the turn open', async () => {
    const [tool] = await source({
      create: linkedTransport([weatherTool], () => new Promise<CallToolResult>(() => {})),
      requestTimeoutMs: 50,
      transientRetry: false,
    }).import();

    const error = await tool?.handler.execute({ city: 'Lisbon' }, CTX).catch((e: unknown) => e);
    expect(isTransientMcpError(error)).toBe(true);
  });

  it('reconnects and retries when the connection drops mid-call', async () => {
    let connects = 0;
    let dropped = false;
    const [tool] = await source({
      create: linkedTransport(
        [weatherTool],
        (params, serverTransport) => {
          if (!dropped) {
            dropped = true;
            void serverTransport.close();
            return new Promise<CallToolResult>(() => {});
          }
          return okCall(params, serverTransport);
        },
        () => {
          connects += 1;
        },
      ),
    }).import();

    expect(await tool?.handler.execute({ city: 'Lisbon' }, CTX)).toBe('sunny in Lisbon');
    expect(connects).toBe(2);
  });

  it('connects once and reuses that connection for every call', async () => {
    let connects = 0;
    const [tool] = await source({
      create: linkedTransport([weatherTool], okCall, () => {
        connects += 1;
      }),
    }).import();

    await tool?.handler.execute({ city: 'Lisbon' }, CTX);
    await Promise.all([
      tool?.handler.execute({ city: 'Porto' }, CTX),
      tool?.handler.execute({ city: 'Faro' }, CTX),
    ]);

    expect(connects).toBe(1);
  });

  it('recycles a client whose transport failed without closing', async () => {
    let connects = 0;
    let failed = false;
    const create = async () => {
      connects += 1;
      const transport = await linkedTransport([weatherTool], okCall)();
      const send = transport.send.bind(transport);
      // A socket error on the POST leaves the transport nominally open, so nothing calls `onclose`
      // — only the source's own recycling can get the next call onto a live connection.
      transport.send = (message, options) => {
        if (!failed && 'method' in message && message.method === 'tools/call') {
          failed = true;
          return Promise.reject(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
        }
        return send(message, options);
      };
      return transport;
    };
    const [tool] = await source({ create }).import();

    expect(await tool?.handler.execute({ city: 'Lisbon' }, CTX)).toBe('sunny in Lisbon');
    expect(connects).toBe(2);
  });

  it('neither retries nor reconnects for a tool error that reads like a transport failure', async () => {
    let calls = 0;
    let connects = 0;
    const [tool] = await source({
      create: linkedTransport(
        [weatherTool],
        () => {
          calls += 1;
          return Promise.resolve({
            content: [{ type: 'text', text: 'fetch failed' }],
            isError: true,
          });
        },
        () => {
          connects += 1;
        },
      ),
    }).import();

    await expect(tool?.handler.execute({ city: 'Lisbon' }, CTX)).rejects.toThrow('fetch failed');
    expect(calls).toBe(1);
    expect(connects).toBe(1);
  });

  it('does not retry a call the server refused on its merits', async () => {
    let calls = 0;
    const [tool] = await source({
      create: linkedTransport([weatherTool], () => {
        calls += 1;
        return Promise.reject(new McpError(ErrorCode.InvalidParams, 'city must be a capital'));
      }),
    }).import();

    await expect(tool?.handler.execute({ city: 'Lisbon' }, CTX)).rejects.toThrow(
      'city must be a capital',
    );
    expect(calls).toBe(1);
  });
});
