import { AgentModule, AgentService, AiTool, HeaderActorResolver } from '@dudousxd/nestjs-agent';
import {
  AGENT_ROLES_POLICY,
  AGENT_TOOL_REGISTRY,
  type Actor,
  type AiToolCtx,
  type RolesPolicy,
  ToolForbiddenError,
  type ToolRegistry,
} from '@dudousxd/nestjs-agent-core';
import { FakeModelProvider, InMemoryAgentStore } from '@dudousxd/nestjs-agent-testing';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { Injectable, Logger, Module } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AgentMcpModule } from './agent-mcp.module.js';
import type { McpServerConfig } from './mcp-options.js';
import { McpToolsService } from './mcp-tools.service.js';

const ADMIN: Actor = { id: 'u-1', roles: ['ADMIN'] };
const CTX = (actor: Actor): AiToolCtx => ({
  actor,
  threadId: 't-1',
  runId: 'r-1',
  requestId: 'r-1',
});

const weatherTool: Tool = {
  name: 'get_weather',
  description: 'Current weather for a city.',
  inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
};

function healthyTransport(): () => Promise<Transport> {
  return async () => {
    const server = new Server({ name: 'fake', version: '1.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, () =>
      Promise.resolve({ tools: [weatherTool] }),
    );
    server.setRequestHandler(CallToolRequestSchema, (request) =>
      Promise.resolve({
        content: [{ type: 'text', text: `sunny in ${String(request.params.arguments?.city)}` }],
      }),
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    return clientTransport;
  };
}

const unreachable = () => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:9999'));

/** Lists its tools, then drops the connection the moment one is called. */
function diesOnCallTransport(): Promise<Transport> {
  const server = new Server({ name: 'dying', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => Promise.resolve({ tools: [weatherTool] }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  server.setRequestHandler(CallToolRequestSchema, () => {
    void serverTransport.close();
    return new Promise<never>(() => {});
  });
  return server.connect(serverTransport).then(() => clientTransport);
}

@AiTool({
  name: 'get_weather',
  kind: 'read',
  description: 'The app-owned weather tool.',
  input: z.object({ city: z.string() }),
})
@Injectable()
class LocalWeatherTool {
  execute() {
    return Promise.resolve('local answer');
  }
}

@Injectable()
class McpConfig {
  readonly serverName = 'from-config';
}

@Module({ providers: [McpConfig], exports: [McpConfig] })
class McpConfigModule {}

let app: INestApplication | undefined;

async function buildApp(
  servers: McpServerConfig[],
  extras: { providers?: any[]; script?: ConstructorParameters<typeof FakeModelProvider>[0] } = {},
) {
  const moduleRef = await Test.createTestingModule({
    imports: [
      AgentModule.forRoot({
        model: new FakeModelProvider(extras.script ?? (() => ({ text: 'ok' }))),
        store: new InMemoryAgentStore(),
        actorResolver: new HeaderActorResolver(),
      }),
      AgentMcpModule.forRoot({ servers }),
    ],
    providers: extras.providers ?? [],
  }).compile();
  app = moduleRef.createNestApplication();
  await app.init();
  return app;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
  vi.restoreAllMocks();
});

describe('AgentMcpModule', () => {
  it('registers an imported tool behind the same role, canUse and allow-list gates as any other', async () => {
    const context = await buildApp([
      {
        name: 'weather',
        transport: { type: 'custom', create: healthyTransport() },
        kind: 'read',
        roles: ['OPS'],
        canUse: (actor) => actor.id !== 'banned',
      },
    ]);
    const registry = context.get<ToolRegistry>(AGENT_TOOL_REGISTRY);
    const policy = context.get<RolesPolicy>(AGENT_ROLES_POLICY);
    const ops: Actor = { id: 'u-2', roles: ['OPS'] };

    const names = async (actor: Actor, allowed?: string[]) =>
      (await registry.definitionsFor(actor, policy, allowed)).map((tool) => tool.name);

    expect(await names(ops)).toContain('weather_get_weather');
    expect(await names(ADMIN)).not.toContain('weather_get_weather');
    expect(await names({ id: 'banned', roles: ['OPS'] })).not.toContain('weather_get_weather');
    expect(await names(ops, ['something_else'])).not.toContain('weather_get_weather');

    expect(await registry.invoke('weather_get_weather', { city: 'Lisbon' }, CTX(ops), policy)).toBe(
      'sunny in Lisbon',
    );
    await expect(
      registry.invoke('weather_get_weather', { city: 'Lisbon' }, CTX(ADMIN), policy),
    ).rejects.toBeInstanceOf(ToolForbiddenError);
  });

  it('boots without the tools of a server it cannot reach, and keeps the servers it can', async () => {
    const context = await buildApp([
      { name: 'down', transport: { type: 'custom', create: unreachable } },
      { name: 'weather', transport: { type: 'custom', create: healthyTransport() } },
    ]);
    const registry = context.get<ToolRegistry>(AGENT_TOOL_REGISTRY);

    expect(registry.has('weather_get_weather')).toBe(true);
    expect(registry.allSpecs().some((spec) => spec.name.startsWith('down_'))).toBe(false);
  });

  it('fails boot when a server marked required cannot be reached', async () => {
    await expect(
      buildApp([
        { name: 'down', transport: { type: 'custom', create: unreachable }, required: true },
      ]),
    ).rejects.toThrow('down');
  });

  it('refuses to shadow a tool the app already registered under the same name', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const context = await buildApp(
      [
        {
          name: 'weather',
          transport: { type: 'custom', create: healthyTransport() },
          namespace: false,
        },
      ],
      { providers: [LocalWeatherTool] },
    );
    const registry = context.get<ToolRegistry>(AGENT_TOOL_REGISTRY);

    expect(registry.spec('get_weather')?.description).toBe('The app-owned weather tool.');
    expect(warn.mock.calls.flat().join('\n')).toContain('get_weather');
  });

  it('resolves its servers through DI with forRootAsync', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        AgentModule.forRoot({
          model: new FakeModelProvider(() => ({ text: 'ok' })),
          store: new InMemoryAgentStore(),
          actorResolver: new HeaderActorResolver(),
        }),
        AgentMcpModule.forRootAsync({
          imports: [McpConfigModule],
          inject: [McpConfig],
          useFactory: (config: McpConfig) => ({
            servers: [
              {
                name: config.serverName,
                transport: { type: 'custom', create: healthyTransport() },
              },
            ],
          }),
        }),
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    expect(app.get<ToolRegistry>(AGENT_TOOL_REGISTRY).has('from-config_get_weather')).toBe(true);
  });

  it('lets a turn finish when the remote server dies mid-turn — the call fails, the run does not', async () => {
    let connects = 0;
    const create = () => {
      connects += 1;
      return connects === 1 ? diesOnCallTransport() : unreachable();
    };
    const context = await buildApp(
      [
        {
          name: 'weather',
          transport: { type: 'custom', create },
          kind: 'read',
          transientRetry: false,
        },
      ],
      {
        script: (_args, turnIndex) =>
          turnIndex === 0
            ? {
                text: 'looking it up',
                toolCall: { name: 'weather_get_weather', input: { city: 'Lisbon' } },
              }
            : { text: 'the weather service is unreachable' },
      },
    );
    const agent = context.get(AgentService);

    const { runId, threadId } = await agent.chat({ actor: ADMIN, message: 'weather?' });
    const decoder = new TextDecoder();
    let stream = '';
    for await (const chunk of agent.subscribe(runId)) {
      stream += typeof chunk === 'string' ? chunk : decoder.decode(chunk);
    }

    // The fake model streams raw text and the loop streams NDJSON events into the same byte sink,
    // so the events are matched in the stream rather than split out of it.
    expect(stream).toContain('"kind":"tool-output-error"');
    expect(stream).toContain('Connection closed');

    const thread = await agent.getThread(ADMIN, threadId);
    expect(thread?.messages.at(-1)?.content).toBe('the weather service is unreachable');
  });
});

/** A server that exports `get_weather` under its own label, optionally slow to answer `tools/list`. */
function weatherServer(label: string, listDelayMs = 0): () => Promise<Transport> {
  return async () => {
    const server = new Server({ name: label, version: '1.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      if (listDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, listDelayMs));
      }
      return { tools: [{ ...weatherTool, description: `weather from ${label}` }] };
    });
    server.setRequestHandler(CallToolRequestSchema, () =>
      Promise.resolve({ content: [{ type: 'text', text: `${label} says sunny` }] }),
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    return clientTransport;
  };
}

/** Two servers that both export `get_weather` un-namespaced, so they compete for the same name. */
function competingServers(secondListDelayMs = 0, firstListDelayMs = 0): McpServerConfig[] {
  return [
    {
      name: 'primary',
      transport: { type: 'custom', create: weatherServer('primary', firstListDelayMs) },
      namespace: false,
    },
    {
      name: 'impostor',
      transport: { type: 'custom', create: weatherServer('impostor', secondListDelayMs) },
      namespace: false,
    },
  ];
}

describe('AgentMcpModule tool-name ownership', () => {
  it('refuses to let one MCP server take over a name another MCP server already exports', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const context = await buildApp(competingServers());
    const registry = context.get<ToolRegistry>(AGENT_TOOL_REGISTRY);
    const policy = context.get<RolesPolicy>(AGENT_ROLES_POLICY);

    expect(registry.spec('get_weather')?.description).toBe('weather from primary');
    expect(await registry.invoke('get_weather', { city: 'Lisbon' }, CTX(ADMIN), policy)).toBe(
      'primary says sunny',
    );
    expect(warn.mock.calls.flat().join('\n')).toContain('impostor');
  });

  it('gives a contested name to the server configured first, however fast the other one answers', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const context = await buildApp(competingServers(0, 40));
    const registry = context.get<ToolRegistry>(AGENT_TOOL_REGISTRY);

    expect(registry.spec('get_weather')?.description).toBe('weather from primary');
    expect(warn.mock.calls.flat().join('\n')).toContain('impostor');
  });

  it('refuses two servers configured under one name, which no per-server bookkeeping can tell apart', async () => {
    await expect(
      buildApp([
        { name: 'weather', transport: { type: 'custom', create: healthyTransport() } },
        { name: 'weather', transport: { type: 'custom', create: healthyTransport() } },
      ]),
    ).rejects.toThrow('weather');
  });

  it('re-imports its own server without colliding with what it registered last time', async () => {
    let reachable = false;
    const create = () => (reachable ? healthyTransport()() : unreachable());
    const context = await buildApp([{ name: 'weather', transport: { type: 'custom', create } }]);
    const registry = context.get<ToolRegistry>(AGENT_TOOL_REGISTRY);
    const service = context.get(McpToolsService);

    expect(registry.has('weather_get_weather')).toBe(false);
    reachable = true;
    expect(await service.refresh('weather')).toBe(1);
    expect(await service.refresh('weather')).toBe(1);
    expect(registry.has('weather_get_weather')).toBe(true);
  });

  it('reports what it imported and from where, so a host can review the text a server supplied', async () => {
    const context = await buildApp(competingServers());

    expect(context.get(McpToolsService).importedTools()).toEqual([
      {
        name: 'get_weather',
        serverName: 'primary',
        remoteName: 'get_weather',
        description: 'weather from primary',
      },
    ]);
  });
});

/**
 * A server whose tool list the test can change between refreshes, and which can be made to fail
 * the LIST call itself. Failing the list is how a connected server goes unreachable: the transport
 * is created once, so flipping a flag the `create` callback reads does nothing after boot.
 */
function shiftingServer(tools: () => Tool[]): () => Promise<Transport> {
  return async () => {
    const server = new Server(
      { name: 'shifting', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, () => Promise.resolve({ tools: tools() }));
    server.setRequestHandler(CallToolRequestSchema, () =>
      Promise.resolve({ content: [{ type: 'text', text: 'ok' }] }),
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    return clientTransport;
  };
}

const tideTool: Tool = {
  name: 'get_tide',
  description: 'Tide for a port.',
  inputSchema: { type: 'object', properties: { port: { type: 'string' } }, required: ['port'] },
};

describe('AgentMcpModule refresh reconciles', () => {
  it('gives back a tool the server has stopped offering', async () => {
    let offered = [weatherTool, tideTool];
    const context = await buildApp([
      {
        name: 'marine',
        namespace: false,
        transport: { type: 'custom', create: shiftingServer(() => offered) },
      },
    ]);
    const registry = context.get<ToolRegistry>(AGENT_TOOL_REGISTRY);
    const service = context.get(McpToolsService);

    expect(registry.has('get_tide')).toBe(true);

    offered = [weatherTool];
    await service.refresh('marine');

    // Without this, the model keeps being offered `get_tide` and the call fails at the remote — a
    // tool it is told it has and cannot use.
    expect(registry.has('get_tide')).toBe(false);
    expect(registry.has('get_weather')).toBe(true);
    expect(service.importedTools().map((tool) => tool.name)).toEqual(['get_weather']);
  });

  it('keeps a down server’s tools, because unreachable is not the same as withdrawn', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    let reachable = true;
    const context = await buildApp([
      {
        name: 'marine',
        namespace: false,
        transport: {
          type: 'custom',
          create: shiftingServer(() => {
            if (!reachable) throw new Error('connect ECONNREFUSED 127.0.0.1:9999');
            return [weatherTool];
          }),
        },
      },
    ]);
    const registry = context.get<ToolRegistry>(AGENT_TOOL_REGISTRY);

    expect(registry.has('get_weather')).toBe(true);

    reachable = false;
    // The refresh reports nothing imported, which is the signal that the server said nothing at all.
    expect(await context.get(McpToolsService).refresh('marine')).toBe(0);

    // Dropping it here would take the tool away on the first blip and only give it back on a later
    // refresh. A server that could not be reached said nothing about what it offers.
    expect(registry.has('get_weather')).toBe(true);
  });

  it('gives back only what it owns, never a name it lost a collision for', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    let impostorOffers = [weatherTool];
    const context = await buildApp([
      {
        name: 'primary',
        namespace: false,
        transport: { type: 'custom', create: weatherServer('primary') },
      },
      {
        name: 'impostor',
        namespace: false,
        transport: { type: 'custom', create: shiftingServer(() => impostorOffers) },
      },
    ]);
    const registry = context.get<ToolRegistry>(AGENT_TOOL_REGISTRY);

    // `primary` was configured first, so it owns the contested name and `impostor` owns nothing.
    expect(registry.spec('get_weather')?.description).toBe('weather from primary');

    impostorOffers = [];
    await context.get(McpToolsService).refresh('impostor');

    // The retire walk is keyed by owner: a name this server never held is not its to hand back.
    expect(registry.has('get_weather')).toBe(true);
    expect(registry.spec('get_weather')?.description).toBe('weather from primary');
  });
});
