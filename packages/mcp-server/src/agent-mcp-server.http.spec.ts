import type { Server as HttpServer } from 'node:http';
import { AgentModule, AiTool } from '@dudousxd/nestjs-agent';
import type { ActorResolver } from '@dudousxd/nestjs-agent-core';
import { FakeModelProvider, InMemoryAgentStore } from '@dudousxd/nestjs-agent-testing';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { type INestApplication, Injectable, type Type } from '@nestjs/common';
import { Tool } from '@nestjs/mcp';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AgentMcpServerModule } from './agent-mcp-server.module.js';
import { BearerTokenActorResolver } from './bearer-token-actor-resolver.js';

const ANALYST_KEY = 'analyst-key-0123456789';
const OPS_KEY = 'ops-key-9876543210';

const purged = vi.fn();

@AiTool({
  name: 'search_docs',
  kind: 'read',
  description: 'Search the handbook.',
  input: z.object({ q: z.string() }),
  roles: ['ANALYST'],
})
@Injectable()
class SearchDocsTool {
  execute(input: { q: string }) {
    return Promise.resolve(`found ${input.q}`);
  }
}

@AiTool({
  name: 'purge_cache',
  kind: 'action',
  description: 'Drop a cache key.',
  input: z.object({ key: z.string() }),
  roles: ['ANALYST'],
})
@Injectable()
class PurgeCacheTool {
  execute(input: { key: string }) {
    purged(input);
    return Promise.resolve('purged');
  }
}

let app: INestApplication | undefined;
/** Connected clients, closed before the app is — an open SSE stream would hold `close()` open. */
const clients: Client[] = [];

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'probe', version: '1.0.0' },
  },
};

/** An application's own `@nestjs/mcp` tool, served beside the agent's to everyone the guard lets in. */
@Injectable()
class PingTools {
  @Tool({ description: 'Ping', inputSchema: z.object({}) })
  ping() {
    return 'pong';
  }
}

/** A tool that names no roles — open by default, closed under `emptyRoles: 'deny'`. */
@AiTool({
  name: 'server_time',
  kind: 'read',
  description: 'What time it is.',
  input: z.object({}),
})
@Injectable()
class ServerTimeTool {
  execute() {
    return Promise.resolve('noon');
  }
}

async function boot(
  overrides: { auth?: ActorResolver; emptyRoles?: 'allow' | 'deny'; tools?: Type<unknown>[] } = {},
): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      AgentModule.forRoot({
        model: new FakeModelProvider(() => ({ text: 'ok' })),
        store: new InMemoryAgentStore(),
        actorResolver: new BearerTokenActorResolver([
          { token: ANALYST_KEY, actor: { id: 'u-analyst', roles: ['ANALYST'] } },
        ]),
      }),
      AgentMcpServerModule.forRoot({
        name: 'spec-server',
        version: '1.0.0',
        auth:
          overrides.auth ??
          new BearerTokenActorResolver([
            { token: ANALYST_KEY, actor: { id: 'u-analyst', roles: ['ANALYST'] } },
            { token: OPS_KEY, actor: { id: 'u-ops', roles: ['OPS'] } },
          ]),
        ...(overrides.emptyRoles !== undefined ? { emptyRoles: overrides.emptyRoles } : {}),
      }),
    ],
    providers: [SearchDocsTool, PurgeCacheTool, ...(overrides.tools ?? [])],
  }).compile();
  const created = moduleRef.createNestApplication();
  await created.listen(0, '127.0.0.1');
  app = created;
  return created;
}

function httpServer(context: INestApplication): HttpServer {
  return context.getHttpServer();
}

function baseUrl(context: INestApplication): string {
  const address = httpServer(context).address();
  if (address === null || typeof address === 'string') {
    throw new Error('the test server is not listening on a TCP port');
  }
  return `http://127.0.0.1:${address.port}/mcp`;
}

/** A real MCP client speaking Streamable HTTP to the mounted endpoint. */
async function connect(input: {
  context: INestApplication;
  token: string;
}): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const transport = new StreamableHTTPClientTransport(new URL(baseUrl(input.context)), {
    requestInit: { headers: { authorization: `Bearer ${input.token}` } },
  });
  const client = new Client({ name: 'spec-client', version: '1.0.0' });
  await client.connect(transport);
  clients.push(client);
  return { client, transport };
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await app?.close();
  app = undefined;
  purged.mockReset();
});

describe('AgentMcpServerModule over HTTP', () => {
  it('answers an unauthenticated caller with 401 on every method', async () => {
    const context = await boot();
    await request(httpServer(context)).post('/mcp').send(INITIALIZE).expect(401);
    await request(httpServer(context)).get('/mcp').expect(401);
    await request(httpServer(context)).delete('/mcp').expect(401);
  });

  it('answers a caller with an unknown key with 401, not 500', async () => {
    const context = await boot();
    await request(httpServer(context))
      .post('/mcp')
      .set('authorization', 'Bearer not-a-real-key-0')
      .send(INITIALIZE)
      .expect(401);
  });

  it('answers 401 when the host resolver rejects with a plain Error', async () => {
    // The resolver seam is the host's: one that throws a bare Error would otherwise reach the
    // client as a 500 with a logged stack, reporting a server fault for an anonymous probe.
    const context = await boot({
      auth: {
        resolve: () => {
          throw new Error('no credential on this request');
        },
      },
    });
    await request(httpServer(context))
      .post('/mcp')
      .set('authorization', `Bearer ${ANALYST_KEY}`)
      .send(INITIALIZE)
      .expect(401);
  });

  it('serves the app’s own @AiTools to an authenticated MCP client', async () => {
    const context = await boot();
    const { client } = await connect({ context, token: ANALYST_KEY });
    const { tools } = await client.listTools();
    // `purge_cache` is an action: on this surface there is nobody to approve it.
    expect(tools.map((tool) => tool.name)).toEqual(['search_docs']);
    const result = await client.callTool({ name: 'search_docs', arguments: { q: 'leave' } });
    expect(result.content).toEqual([{ type: 'text', text: 'found leave' }]);
    expect(purged).not.toHaveBeenCalled();
  });

  it('offers a caller nothing when their roles reach nothing', async () => {
    const context = await boot();
    const { client } = await connect({ context, token: OPS_KEY });
    expect((await client.listTools()).tools).toEqual([]);
  });

  it('offers a tool that names no roles to anyone, by default', async () => {
    const context = await boot({ tools: [ServerTimeTool] });
    const { client } = await connect({ context, token: OPS_KEY });
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(['server_time']);
  });

  it("under emptyRoles: 'deny' a tool that names no roles is neither listed nor runnable", async () => {
    const context = await boot({ tools: [ServerTimeTool], emptyRoles: 'deny' });
    const { client } = await connect({ context, token: ANALYST_KEY });
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(['search_docs']);
    // Not registered for this caller at all: the call is refused as an unknown tool.
    await expect(client.callTool({ name: 'server_time', arguments: {} })).rejects.toThrow(
      /not found/,
    );
  });

  it('serves the application’s own @nestjs/mcp @Tool() methods beside the agent’s tools', async () => {
    const context = await boot({ tools: [PingTools] });
    const { client } = await connect({ context, token: ANALYST_KEY });
    expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
      'ping',
      'search_docs',
    ]);
    const result = await client.callTool({ name: 'ping', arguments: {} });
    expect(result.content).toEqual([{ type: 'text', text: 'pong' }]);
  });

  it('authenticates every request on its own: a list from one caller is not another’s', async () => {
    // Stateless: there is no session to borrow. Each request is listed for whoever it
    // authenticated as.
    const context = await boot();
    const analyst = await connect({ context, token: ANALYST_KEY });
    const ops = await connect({ context, token: OPS_KEY });
    expect((await analyst.client.listTools()).tools.map((tool) => tool.name)).toEqual([
      'search_docs',
    ]);
    expect((await ops.client.listTools()).tools).toEqual([]);
    // Never registered for this caller: there is nothing to call.
    await expect(
      ops.client.callTool({ name: 'search_docs', arguments: { q: 'x' } }),
    ).rejects.toThrow();
  });
});
