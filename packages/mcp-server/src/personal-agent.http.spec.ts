import type { Server as HttpServer } from 'node:http';
import { AgentModule, AiTool } from '@dudousxd/nestjs-agent';
import {
  type ActorResolver,
  POPPY_AUTHENTICATE_SLOT,
  POPPY_ISSUER_SLOT,
  type PoppyAuthenticate,
} from '@dudousxd/nestjs-agent-core';
import { FakeModelProvider, InMemoryAgentStore } from '@dudousxd/nestjs-agent-testing';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { type INestApplication, Injectable, UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AgentMcpServerModule } from './agent-mcp-server.module.js';
import type { AgentMcpServerModuleOptions } from './agent-mcp-server.options.js';
import { asPersonalAgent, poppyActorResolver } from './poppy-actor-resolver.js';

const ran = vi.fn();

@AiTool({
  name: 'read_orders',
  kind: 'read',
  description: 'Read the orders.',
  input: z.object({}),
  roles: ['scope:r'],
})
@Injectable()
class ReadOrdersTool {
  execute() {
    ran('read_orders');
    return Promise.resolve('ran read_orders');
  }
}

@AiTool({
  name: 'cancel_order',
  kind: 'action',
  description: 'Cancel an order.',
  input: z.object({}),
  roles: ['scope:w'],
})
@Injectable()
class CancelOrderTool {
  execute() {
    ran('cancel_order');
    return Promise.resolve('ran cancel_order');
  }
}

/** Not written for personal agents: no roles, so anyone's by default — but never a personal agent's. */
@AiTool({
  name: 'internal_tool',
  kind: 'action',
  description: 'Internal.',
  input: z.object({}),
})
@Injectable()
class InternalTool {
  execute() {
    ran('internal_tool');
    return Promise.resolve('ran internal_tool');
  }
}

/** `pa-read` is a personal agent granted `r`; `admin` is a regular login. */
const personalAuth: ActorResolver = {
  resolve(req: unknown) {
    const header = (req as { headers: Record<string, string | undefined> }).headers.authorization;
    if (header === 'Bearer pa-read') return asPersonalAgent({ id: 'acc-1' }, ['r']);
    if (header === 'Bearer admin') return { id: 'acc-1', roles: ['ADMIN'] };
    throw new UnauthorizedException('invalid or expired access token');
  },
};

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

let app: INestApplication | undefined;
const clients: Client[] = [];
const globals = globalThis as Record<symbol, unknown>;

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await app?.close();
  app = undefined;
  ran.mockReset();
  delete globals[POPPY_AUTHENTICATE_SLOT];
  delete globals[POPPY_ISSUER_SLOT];
});

async function boot(
  overrides: Partial<AgentMcpServerModuleOptions> = {},
  agent: { defaultRoles?: string[] } = {},
): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      AgentModule.forRoot({
        model: new FakeModelProvider(() => ({ text: 'ok' })),
        store: new InMemoryAgentStore(),
        actorResolver: personalAuth,
        ...(agent.defaultRoles !== undefined ? { defaultRoles: agent.defaultRoles } : {}),
      }),
      AgentMcpServerModule.forRoot({
        name: 'spec-server',
        version: '1.0.0',
        auth: personalAuth,
        actions: 'execute',
        ...overrides,
      }),
    ],
    providers: [ReadOrdersTool, CancelOrderTool, InternalTool],
  }).compile();
  const created = moduleRef.createNestApplication();
  await created.listen(0, '127.0.0.1');
  app = created;
  return created;
}

function httpServer(context: INestApplication): HttpServer {
  return context.getHttpServer();
}

function origin(context: INestApplication): string {
  const address = httpServer(context).address();
  if (address === null || typeof address === 'string') {
    throw new Error('the test server is not listening on a TCP port');
  }
  return `http://127.0.0.1:${address.port}`;
}

async function connect(input: {
  context: INestApplication;
  token: string;
}): Promise<{ client: Client; sessionId: string }> {
  const transport = new StreamableHTTPClientTransport(new URL(`${origin(input.context)}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${input.token}` } },
  });
  const client = new Client({ name: 'spec-client', version: '1.0.0' });
  await client.connect(transport as Transport);
  clients.push(client);
  return { client, sessionId: transport.sessionId ?? '' };
}

/** A raw `tools/call` on an open session — to read the HTTP status and challenge. */
function rawCall(input: {
  context: INestApplication;
  token: string;
  sessionId: string;
  body: unknown;
}) {
  return request(httpServer(input.context))
    .post('/mcp')
    .set('authorization', `Bearer ${input.token}`)
    .set('accept', 'application/json, text/event-stream')
    .set('mcp-session-id', input.sessionId)
    .send(input.body as object);
}

function toolsCall(name: string, id = 2) {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: {} } };
}

describe('a personal agent on the MCP server', () => {
  it('is offered the tools written for personal agents, granted or not, and nothing else', async () => {
    const context = await boot();
    const { client } = await connect({ context, token: 'pa-read' });
    const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
    expect(names).toEqual(['cancel_order', 'read_orders']);
  });

  it('runs a granted tool', async () => {
    const context = await boot();
    const { client } = await connect({ context, token: 'pa-read' });
    const result = await client.callTool({ name: 'read_orders', arguments: {} });
    expect(result.content).toEqual([{ type: 'text', text: 'ran read_orders' }]);
    expect(ran).toHaveBeenCalledWith('read_orders');
  });

  it('answers an offered but ungranted tool 403 insufficient_scope with the scope, and runs nothing', async () => {
    const context = await boot();
    const { sessionId } = await connect({ context, token: 'pa-read' });
    const res = await rawCall({
      context,
      token: 'pa-read',
      sessionId,
      body: toolsCall('cancel_order'),
    });
    expect(res.status).toBe(403);
    expect(res.headers['www-authenticate']).toBe('Bearer error="insufficient_scope", scope="w"');
    expect(res.body).toMatchObject({ error: 'insufficient_scope' });
    expect(ran).not.toHaveBeenCalled();
  });

  it('refuses a batched body when any call in it lacks its scope', async () => {
    const context = await boot();
    const { sessionId } = await connect({ context, token: 'pa-read' });
    const res = await rawCall({
      context,
      token: 'pa-read',
      sessionId,
      body: [toolsCall('read_orders', 2), toolsCall('cancel_order', 3)],
    });
    expect(res.status).toBe(403);
    expect(res.headers['www-authenticate']).toContain('scope="w"');
    expect(ran).not.toHaveBeenCalled();
  });

  it('names the metadata document in the step-up when one is served', async () => {
    const context = await boot({ oauth: { issuer: 'https://auth.example.com' } });
    const { sessionId } = await connect({ context, token: 'pa-read' });
    const res = await rawCall({
      context,
      token: 'pa-read',
      sessionId,
      body: toolsCall('cancel_order'),
    });
    expect(res.status).toBe(403);
    expect(res.headers['www-authenticate']).toContain(
      `resource_metadata="${origin(context)}/.well-known/oauth-protected-resource/mcp"`,
    );
  });

  it('leaves a tool this surface does not expose to the server’s own refusal', async () => {
    // `cancel_order` is an action, and actions are not exposed by default: no step-up for it.
    const context = await boot({ actions: 'deny' });
    const { client } = await connect({ context, token: 'pa-read' });
    const result = await client.callTool({ name: 'cancel_order', arguments: {} });
    expect(result.isError).toBe(true);
    expect(ran).not.toHaveBeenCalled();
  });

  it('never reaches a tool not written for personal agents (the server’s refusal, not a step-up)', async () => {
    const context = await boot();
    const { client } = await connect({ context, token: 'pa-read' });
    const result = await client.callTool({ name: 'internal_tool', arguments: {} });
    expect(result.isError).toBe(true);
    expect(ran).not.toHaveBeenCalled();
  });

  it('leaves a regular login untouched', async () => {
    const context = await boot();
    const { client } = await connect({ context, token: 'admin' });
    const result = await client.callTool({ name: 'internal_tool', arguments: {} });
    expect(result.content).toEqual([{ type: 'text', text: 'ran internal_tool' }]);
  });

  it("keeps the agent's default roles under emptyRoles: 'deny' behind the gate", async () => {
    // `internal_tool` declares no roles: it falls back on `defaultRoles`, which the gate must not
    // hide from `closeEmptyRoles`.
    const context = await boot({ emptyRoles: 'deny' }, { defaultRoles: ['ADMIN'] });
    const { client } = await connect({ context, token: 'admin' });
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain('internal_tool');
  });
});

describe('poppyActorResolver on the MCP server', () => {
  const principal = {
    userId: 'u-1',
    clientId: 'https://agent.example/agent.json',
    sessionId: 's-1',
  };

  function install(authenticate: PoppyAuthenticate): void {
    globals[POPPY_AUTHENTICATE_SLOT] = authenticate;
  }

  it('answers a signed-out Session’s token 403 sign_in_required, not invalid_token', async () => {
    const seen: unknown[] = [];
    install(async (req) => {
      seen.push(req);
      return {
        ok: true,
        principal: { ...principal, accountId: null, scopes: [], signedIn: false },
      };
    });
    const context = await boot({ auth: poppyActorResolver() });
    const res = await request(httpServer(context))
      .post('/mcp')
      .set('authorization', 'Bearer poppy-signed-out')
      .send(INITIALIZE);
    expect(res.status).toBe(403);
    expect(res.headers['www-authenticate']).toBe('Bearer error="sign_in_required"');
    expect(seen[0]).toMatchObject({
      method: 'POST',
      url: `${origin(context)}/mcp`,
      headers: { authorization: 'Bearer poppy-signed-out' },
    });
  });

  it('answers a refused token with the verifier’s status, challenge and headers', async () => {
    install(async () => ({
      ok: false,
      status: 401,
      error: 'use_dpop_nonce',
      wwwAuthenticate: 'DPoP error="use_dpop_nonce"',
      headers: { 'DPoP-Nonce': 'n-1' },
    }));
    globals[POPPY_ISSUER_SLOT] = 'https://auth.example.com';
    const context = await boot({ auth: poppyActorResolver() });
    const res = await request(httpServer(context))
      .post('/mcp')
      .set('authorization', 'DPoP tok')
      .send(INITIALIZE);
    expect(res.status).toBe(401);
    expect(res.headers['dpop-nonce']).toBe('n-1');
    expect(res.headers['www-authenticate']).toBe(
      `DPoP error="use_dpop_nonce", resource_metadata="${origin(context)}/.well-known/oauth-protected-resource/mcp"`,
    );
  });

  it('acts as the account, a personal agent of the granted scopes', async () => {
    install(async () => ({
      ok: true,
      principal: { ...principal, accountId: 'acc-1', scopes: ['r'], signedIn: true },
    }));
    const context = await boot({ auth: poppyActorResolver() });
    const { client } = await connect({ context, token: 'signed-in' });
    expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
      'cancel_order',
      'read_orders',
    ]);
    const result = await client.callTool({ name: 'read_orders', arguments: {} });
    expect(result.content).toEqual([{ type: 'text', text: 'ran read_orders' }]);
  });

  it('answers 501 when there is no verifier at all', async () => {
    const context = await boot({ auth: poppyActorResolver() });
    await request(httpServer(context))
      .post('/mcp')
      .set('authorization', 'Bearer x')
      .send(INITIALIZE)
      .expect(501);
  });
});

describe('protected-resource metadata (RFC 9728)', () => {
  const wellKnown = '/.well-known/oauth-protected-resource/mcp';

  it('is not served with neither an oauth option nor a Poppy issuer', async () => {
    const context = await boot();
    await request(httpServer(context)).get(wellKnown).expect(404);
    const res = await request(httpServer(context)).post('/mcp').send(INITIALIZE);
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toBe('Bearer');
  });

  it('names the configured issuer, plus the announced Poppy issuer once (Poppy §6)', async () => {
    const context = await boot({
      oauth: {
        issuer: 'https://app.example.com/oidc',
        scopesSupported: ['r', 'w'],
        resourceName: 'Acme',
      },
    });
    const first = await request(httpServer(context)).get(wellKnown).expect(200);
    expect(first.body).toEqual({
      resource: `${origin(context)}/mcp`,
      authorization_servers: ['https://app.example.com/oidc'],
      bearer_methods_supported: ['header'],
      scopes_supported: ['r', 'w'],
      resource_name: 'Acme',
    });
    globals[POPPY_ISSUER_SLOT] = 'https://auth.example.com';
    const second = await request(httpServer(context)).get(wellKnown).expect(200);
    expect(second.body.authorization_servers).toEqual([
      'https://app.example.com/oidc',
      'https://auth.example.com',
    ]);
    globals[POPPY_ISSUER_SLOT] = 'https://app.example.com/oidc';
    const third = await request(httpServer(context)).get(wellKnown).expect(200);
    expect(third.body.authorization_servers).toEqual(['https://app.example.com/oidc']);
  });

  it('is served with just the Poppy issuer when no oauth option is configured', async () => {
    globals[POPPY_ISSUER_SLOT] = 'https://auth.example.com';
    const context = await boot({ baseUrl: 'https://app.example.com' });
    const res = await request(httpServer(context)).get(wellKnown).expect(200);
    expect(res.body).toEqual({
      resource: 'https://app.example.com/mcp',
      authorization_servers: ['https://auth.example.com'],
      bearer_methods_supported: ['header'],
    });
  });

  it('is named by every 401 challenge, with invalid_token when a token was sent', async () => {
    const context = await boot({
      oauth: { issuer: 'https://auth.example.com' },
      path: 'tools/mcp',
    });
    const metadata = `${origin(context)}/.well-known/oauth-protected-resource/tools/mcp`;
    await request(httpServer(context))
      .get('/.well-known/oauth-protected-resource/tools/mcp')
      .expect(200);
    const bare = await request(httpServer(context)).post('/tools/mcp').send(INITIALIZE);
    expect(bare.status).toBe(401);
    expect(bare.headers['www-authenticate']).toBe(`Bearer resource_metadata="${metadata}"`);
    const wrong = await request(httpServer(context))
      .post('/tools/mcp')
      .set('authorization', 'Bearer nope')
      .send(INITIALIZE);
    expect(wrong.status).toBe(401);
    expect(wrong.headers['www-authenticate']).toBe(
      `Bearer error="invalid_token", resource_metadata="${metadata}"`,
    );
  });
});

describe('forRootAsync', () => {
  it('builds the options once, for both the endpoint and its metadata document', async () => {
    const factory = vi.fn(
      (): AgentMcpServerModuleOptions => ({
        name: 'spec-server',
        version: '1.0.0',
        auth: personalAuth,
        oauth: { issuer: 'https://auth.example.com' },
      }),
    );
    const moduleRef = await Test.createTestingModule({
      imports: [
        AgentModule.forRoot({
          model: new FakeModelProvider(() => ({ text: 'ok' })),
          store: new InMemoryAgentStore(),
          actorResolver: personalAuth,
        }),
        AgentMcpServerModule.forRootAsync({ useFactory: factory }),
      ],
      providers: [ReadOrdersTool],
    }).compile();
    const context = moduleRef.createNestApplication();
    await context.listen(0, '127.0.0.1');
    app = context;
    expect(factory).toHaveBeenCalledTimes(1);
    const res = await request(httpServer(context))
      .get('/.well-known/oauth-protected-resource/mcp')
      .expect(200);
    expect(res.body.authorization_servers).toEqual(['https://auth.example.com']);
    const { client } = await connect({ context, token: 'pa-read' });
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(['read_orders']);
  });
});
