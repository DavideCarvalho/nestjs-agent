import type { Server as HttpServer } from 'node:http';
import { AgentModule, AiTool } from '@dudousxd/nestjs-agent';
import type { ActorResolver } from '@dudousxd/nestjs-agent-core';
import { FakeModelProvider, InMemoryAgentStore } from '@dudousxd/nestjs-agent-testing';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { type INestApplication, Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AgentMcpServerModule } from './agent-mcp-server.module.js';
import { BearerTokenActorResolver } from './bearer-token-actor-resolver.js';
import { McpSessionStore } from './mcp-sessions.js';

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

async function boot(overrides: { auth?: ActorResolver } = {}): Promise<INestApplication> {
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
      }),
    ],
    providers: [SearchDocsTool, PurgeCacheTool],
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
  // The SDK's own transports expose `sessionId` as `string | undefined` where the `Transport`
  // interface declares the property optional, which `exactOptionalPropertyTypes` reads as a
  // mismatch — the class does implement the interface it is declared against.
  await client.connect(transport as Transport);
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

  it('refuses a session id presented by a different actor', async () => {
    const context = await boot();
    const { transport } = await connect({ context, token: ANALYST_KEY });
    const sessionId = transport.sessionId;
    expect(sessionId).toBeDefined();
    // The session id travels in a plain header and owns an open stream; holding one is not
    // permission to act as the identity that opened it.
    await request(httpServer(context))
      .post('/mcp')
      .set('authorization', `Bearer ${OPS_KEY}`)
      .set('accept', 'application/json, text/event-stream')
      .set('mcp-session-id', sessionId ?? '')
      .send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
      .expect(403);
  });

  it('tells a client to start again when it names a session this process does not hold', async () => {
    const context = await boot();
    await request(httpServer(context))
      .post('/mcp')
      .set('authorization', `Bearer ${ANALYST_KEY}`)
      .set('mcp-session-id', 'a-session-that-never-existed')
      .send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
      .expect(404);
  });

  it('rejects a request that is neither a session nor an initialize', async () => {
    const context = await boot();
    await request(httpServer(context))
      .post('/mcp')
      .set('authorization', `Bearer ${ANALYST_KEY}`)
      .send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
      .expect(400);
    await request(httpServer(context))
      .get('/mcp')
      .set('authorization', `Bearer ${ANALYST_KEY}`)
      .expect(400);
  });

  it('forgets a session the client terminated', async () => {
    const context = await boot();
    const sessions = context.get(McpSessionStore);
    const { transport } = await connect({ context, token: ANALYST_KEY });
    expect(sessions.size).toBe(1);
    await transport.terminateSession();
    expect(sessions.size).toBe(0);
  });

  it('closes what it is still holding when the application shuts down', async () => {
    const context = await boot();
    const sessions = context.get(McpSessionStore);
    await connect({ context, token: ANALYST_KEY });
    expect(sessions.size).toBe(1);
    await sessions.onApplicationShutdown();
    expect(sessions.size).toBe(0);
  });
});
