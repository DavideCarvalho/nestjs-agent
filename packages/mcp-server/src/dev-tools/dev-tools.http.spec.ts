import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import type { Server as HttpServer } from 'node:http';
import { AgentModule, AiTool } from '@dudousxd/nestjs-agent';
import { FakeModelProvider, InMemoryAgentStore } from '@dudousxd/nestjs-agent-testing';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
  Injectable,
  Logger,
  UseGuards,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AgentMcpServerModule } from '../agent-mcp-server.module.js';
import type { AgentMcpServerModuleOptions } from '../agent-mcp-server.options.js';
import { BearerTokenActorResolver } from '../bearer-token-actor-resolver.js';
import {
  DEV_TOOLS_SLOT,
  type DevTool,
  type DevToolsDecision,
  type DevToolsLib,
  registerDevTools,
} from './contract.js';

const PRODUCT_KEY = 'product-key-0123456789';
const ALL = 'all-libs-token';
const DURABLE_ONLY = 'durable-only-token';

const bearer = (context: ExecutionContext) =>
  context.switchToHttp().getRequest<{ headers: Record<string, string | undefined> }>().headers
    .authorization;

const retried = vi.fn();

function durableLib(authorize = vi.fn(byToken([ALL, DURABLE_ONLY]))): DevToolsLib {
  return {
    lib: 'durable',
    title: 'Durable workflows',
    authorize,
    tools: [
      {
        name: 'durable_list_runs',
        kind: 'read',
        description: 'Runs, newest first.',
        input: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['running', 'failed'] },
            limit: { type: 'integer', minimum: 1, maximum: 100 },
          },
        },
        run: async (input, call) => ({
          items: [{ id: 'r1', status: input.status ?? 'running', secretToken: 'leak' }],
          next: null,
          caller: call.caller.id,
        }),
      },
      {
        name: 'durable_get_blob',
        kind: 'read',
        description: 'A big result.',
        input: { type: 'object', properties: {} },
        run: async () => ({
          items: Array.from({ length: 1000 }, (_, i) => ({ i, pad: 'x'.repeat(200) })),
          next: 2,
        }),
      },
      {
        name: 'durable_retry_run',
        kind: 'action',
        description: 'Retry a run.',
        input: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        run: async (input) => {
          retried(input);
          return { status: 'queued' };
        },
      },
    ],
  };
}

function telescopeLib(authorize = vi.fn(byToken([ALL]))): DevToolsLib {
  return {
    lib: 'telescope',
    title: 'Telescope',
    authorize,
    tools: [readTool('telescope_list_entries')],
  };
}

function paymentsLib(): DevToolsLib {
  return {
    lib: 'payments',
    title: 'Payments',
    authorize: async () => ({ allowed: false, reason: 'forbidden' }),
    tools: [readTool('payments_list_payments')],
  };
}

function readTool(name: string): DevTool {
  return {
    name,
    kind: 'read',
    description: `${name}.`,
    input: { type: 'object', properties: {} },
    run: async () => ({ items: [], next: null }),
  };
}

/** Allowed for these tokens; no token → unauthenticated; another token → forbidden. */
function byToken(tokens: string[]) {
  return async (context: ExecutionContext): Promise<DevToolsDecision> => {
    const header = bearer(context);
    if (header === undefined) return { allowed: false, reason: 'unauthenticated' };
    return tokens.some((token) => header === `Bearer ${token}`)
      ? { allowed: true }
      : { allowed: false, reason: 'forbidden' };
  };
}

@AiTool({
  name: 'search_docs',
  kind: 'read',
  description: 'Search the handbook.',
  input: z.object({ q: z.string() }),
})
@Injectable()
class SearchDocsTool {
  execute() {
    return Promise.resolve('found');
  }
}

/** An app guard that signs a user in, as a session guard would. */
@Injectable()
class SessionGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string>; user?: unknown }>();
    if (req.headers['x-user'] !== undefined) req.user = { id: req.headers['x-user'] };
    return true;
  }
}

let app: INestApplication | undefined;
const clients: Client[] = [];
const unregister: Array<() => void> = [];

function register(...libs: DevToolsLib[]): void {
  for (const lib of libs) {
    const off = registerDevTools(lib);
    if (off !== undefined) unregister.push(off);
  }
}

async function boot(
  overrides: Partial<Pick<AgentMcpServerModuleOptions, 'devTools' | 'actions'>> = {},
): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      AgentModule.forRoot({
        model: new FakeModelProvider(() => ({ text: 'ok' })),
        store: new InMemoryAgentStore(),
      }),
      AgentMcpServerModule.forRoot({
        name: 'spec-server',
        version: '1.0.0',
        auth: new BearerTokenActorResolver([
          { token: PRODUCT_KEY, actor: { id: 'u-product', roles: [] } },
        ]),
        ...overrides,
      }),
    ],
    providers: [SearchDocsTool],
  }).compile();
  const created = moduleRef.createNestApplication({ logger: false });
  await created.listen(0, '127.0.0.1');
  app = created;
  return created;
}

const server = (context: INestApplication): HttpServer => context.getHttpServer();

function url(context: INestApplication, path: string): URL {
  const address = server(context).address();
  if (address === null || typeof address === 'string') throw new Error('not listening');
  return new URL(`http://127.0.0.1:${address.port}/${path}`);
}

async function connect(
  context: INestApplication,
  headers: Record<string, string>,
  path = 'mcp/aviary',
): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(url(context, path), {
    requestInit: { headers },
  });
  const client = new Client({ name: 'spec-client', version: '1.0.0' });
  await client.connect(transport);
  clients.push(client);
  return client;
}

const toolNames = async (client: Client) =>
  (await client.listTools()).tools.map((tool) => tool.name).sort();

const textOf = (result: unknown) =>
  ((result as { content: Array<{ text: string }> }).content[0]?.text ?? '') as string;

const rpc = (method: string, params: Record<string, unknown> = {}) => ({
  jsonrpc: '2.0',
  id: 1,
  method,
  params,
});

const post = (context: INestApplication, body: unknown, token?: string) => {
  const req = request(server(context))
    .post('/mcp/aviary')
    .set('accept', 'application/json, text/event-stream')
    .set('content-type', 'application/json');
  return (token === undefined ? req : req.set('authorization', `Bearer ${token}`)).send(
    body as object,
  );
};

beforeEach(() => {
  delete (globalThis as Record<symbol, unknown>)[DEV_TOOLS_SLOT];
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await app?.close();
  app = undefined;
  for (const off of unregister.splice(0)) off();
  retried.mockReset();
  vi.restoreAllMocks();
});

describe('dev MCP endpoint: access per lib', () => {
  it('lists only the tools of the libs the caller is allowed into, reads only', async () => {
    register(durableLib(), telescopeLib(), paymentsLib());
    const context = await boot();
    const all = await connect(context, { authorization: `Bearer ${ALL}` });
    expect(await toolNames(all)).toEqual([
      'durable_get_blob',
      'durable_list_runs',
      'telescope_list_entries',
    ]);
    expect(all.getInstructions()).toContain('Tools for: Durable workflows, Telescope.');
    expect(all.getInstructions()).not.toContain('Payments');

    const durable = await connect(context, { authorization: `Bearer ${DURABLE_ONLY}` });
    expect(await toolNames(durable)).toEqual(['durable_get_blob', 'durable_list_runs']);
  });

  it('runs a tool, redacting secret-looking keys and passing the hashed caller', async () => {
    register(durableLib());
    const context = await boot();
    const client = await connect(context, { authorization: `Bearer ${ALL}` });
    const result = await client.callTool({
      name: 'durable_list_runs',
      arguments: { status: 'failed' },
    });
    const body = JSON.parse(textOf(result)) as {
      items: Array<Record<string, unknown>>;
      caller: string;
    };
    expect(body.items[0]).toEqual({ id: 'r1', status: 'failed', secretToken: '[redacted]' });
    expect(body.caller).toMatch(/^token:[0-9a-f]{12}$/);
  });

  it('answers a call to a denied lib with the console’s 403', async () => {
    register(durableLib(), paymentsLib());
    const context = await boot();
    const res = await post(context, rpc('tools/call', { name: 'payments_list_payments' }), ALL);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'forbidden' });
  });

  it('answers 401 with a bare Bearer challenge when every lib wants a sign-in', async () => {
    register(durableLib(), telescopeLib());
    const context = await boot();
    const res = await post(context, rpc('tools/list'));
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'unauthenticated' });
    expect(res.headers['www-authenticate']).toBe('Bearer realm="aviary-dev"');
    expect(res.headers['www-authenticate']).not.toContain('resource_metadata');
  });

  it('treats an authorize that throws as forbidden', async () => {
    register(
      durableLib(
        vi.fn(async () => {
          throw new Error('boom');
        }),
      ),
    );
    const context = await boot();
    const res = await post(context, rpc('tools/list'), ALL);
    expect(res.status).toBe(403);
  });

  it('runs each needed authorize once per request, and only the called tool’s lib', async () => {
    const durableAuthorize = vi.fn(byToken([ALL]));
    const telescopeAuthorize = vi.fn(byToken([ALL]));
    register(durableLib(durableAuthorize), telescopeLib(telescopeAuthorize));
    const context = await boot();
    await post(context, rpc('tools/list'), ALL).expect(200);
    expect(durableAuthorize).toHaveBeenCalledTimes(1);
    expect(telescopeAuthorize).toHaveBeenCalledTimes(1);

    await post(context, rpc('tools/call', { name: 'durable_list_runs', arguments: {} }), ALL);
    expect(durableAuthorize).toHaveBeenCalledTimes(2);
    expect(telescopeAuthorize).toHaveBeenCalledTimes(1);
  });

  it('answers an unknown tool with an error, after authorizing every lib', async () => {
    const durableAuthorize = vi.fn(byToken([ALL]));
    register(durableLib(durableAuthorize));
    const context = await boot();
    const client = await connect(context, { authorization: `Bearer ${ALL}` });
    durableAuthorize.mockClear();
    await expect(client.callTool({ name: 'durable_nope', arguments: {} })).rejects.toThrow(
      /not found/,
    );
    expect(durableAuthorize).toHaveBeenCalled();
  });

  it('rejects input outside the tool’s schema', async () => {
    register(durableLib());
    const context = await boot();
    const client = await connect(context, { authorization: `Bearer ${ALL}` });
    const result = await client.callTool({
      name: 'durable_list_runs',
      arguments: { status: 'nope', extra: true },
    });
    expect(result.isError).toBe(true);
  });

  it('serves a 2025-era client (Claude Code) its initialize and tools/list', async () => {
    register(durableLib());
    const context = await boot();
    const init = await post(
      context,
      rpc('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'claude-code', version: '1.0.0' },
      }),
      ALL,
    );
    expect(init.status).toBe(200);
    expect(init.text).toContain('Durable workflows');
    const list = await post(context, rpc('tools/list'), ALL).set(
      'mcp-protocol-version',
      '2025-06-18',
    );
    expect(list.status).toBe(200);
    expect(list.text).toContain('durable_list_runs');
  });

  it('answers GET and DELETE with 405 once authorized, 401 before', async () => {
    register(durableLib());
    const context = await boot();
    await request(server(context)).get('/mcp/aviary').expect(401);
    const res = await request(server(context))
      .get('/mcp/aviary')
      .set('authorization', `Bearer ${ALL}`)
      .expect(405);
    expect(res.headers.allow).toBe('POST');
    await request(server(context))
      .delete('/mcp/aviary')
      .set('authorization', `Bearer ${ALL}`)
      .expect(405);
  });

  it('refuses a browser page from another origin', async () => {
    register(durableLib());
    const context = await boot();
    const res = await post(context, rpc('tools/list'), ALL).set('origin', 'https://evil.example');
    expect(res.status).toBe(403);
  });

  it('takes the caller from request.user set by an app guard in devTools.decorators', async () => {
    register({
      ...durableLib(vi.fn(async () => ({ allowed: true }) as const)),
    });
    const context = await boot({ devTools: { decorators: [UseGuards(SessionGuard)] } });
    const client = await connect(context, { 'x-user': '42' });
    const result = await client.callTool({ name: 'durable_list_runs', arguments: {} });
    expect((JSON.parse(textOf(result)) as { caller: string }).caller).toBe('user:42');
  });
});

describe('dev MCP endpoint: actions', () => {
  it('hides and refuses actions by default, even with the product actions: execute', async () => {
    register(durableLib());
    const context = await boot({ actions: 'execute' });
    const client = await connect(context, { authorization: `Bearer ${ALL}` });
    expect(await toolNames(client)).not.toContain('durable_retry_run');
    await expect(
      client.callTool({ name: 'durable_retry_run', arguments: { id: 'r1' } }),
    ).rejects.toThrow(/not found/);
    expect(retried).not.toHaveBeenCalled();
  });

  it('exposes the actions of the libs listed in devTools.actions', async () => {
    register(durableLib());
    const context = await boot({ devTools: { actions: ['durable'] } });
    const client = await connect(context, { authorization: `Bearer ${ALL}` });
    const listed = (await client.listTools()).tools.find((t) => t.name === 'durable_retry_run');
    expect(listed?.annotations).toEqual({ readOnlyHint: false, destructiveHint: false });
    await client.callTool({ name: 'durable_retry_run', arguments: { id: 'r1' } });
    expect(retried).toHaveBeenCalledWith({ id: 'r1' });
  });
});

describe('dev MCP endpoint: isolation and options', () => {
  it('keeps dev tools off the product endpoint, and product tools off the dev one', async () => {
    register(durableLib());
    const context = await boot();
    const product = await connect(context, { authorization: `Bearer ${PRODUCT_KEY}` }, 'mcp');
    expect(await toolNames(product)).toEqual(['search_docs']);
    const dev = await connect(context, { authorization: `Bearer ${ALL}` });
    expect(await toolNames(dev)).not.toContain('search_docs');
    // The product key opens nothing here: durable's own gate does not know it.
    await post(context, rpc('tools/list'), PRODUCT_KEY).expect(403);
    await request(server(context))
      .get('/.well-known/oauth-protected-resource/mcp/aviary')
      .expect(404);
  });

  it('mounts nothing with devTools: false', async () => {
    register(durableLib());
    const context = await boot({ devTools: false });
    await post(context, rpc('tools/list'), ALL).expect(404);
  });

  it('fails the boot when devTools.path is the product path', () => {
    expect(() =>
      AgentMcpServerModule.forRoot({
        name: 's',
        version: '1',
        auth: new BearerTokenActorResolver([]),
        devTools: { path: 'mcp' },
      }),
    ).toThrow(/own path/);
  });

  it('applies exclude and serves a lib that registers after boot', async () => {
    const context = await boot({ devTools: { exclude: ['durable_get_blob', 'telescope'] } });
    register(durableLib(), telescopeLib());
    const client = await connect(context, { authorization: `Bearer ${ALL}` });
    expect(await toolNames(client)).toEqual(['durable_list_runs']);
  });

  it('caps a result at 48 KB with truncated', async () => {
    register(durableLib());
    const context = await boot();
    const client = await connect(context, { authorization: `Bearer ${ALL}` });
    const text = textOf(await client.callTool({ name: 'durable_get_blob', arguments: {} }));
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(48 * 1024);
    expect(JSON.parse(text)).toMatchObject({ truncated: true, next: 2 });
  });

  it('audits each call: one log line and an agent:devtools.call event', async () => {
    register(durableLib());
    const log = vi.spyOn(Logger.prototype, 'log');
    const events: unknown[] = [];
    const listener = (message: unknown) => events.push(message);
    subscribe('aviary:agent:devtools.call', listener);
    try {
      const context = await boot({ devTools: { actions: 'execute' } });
      const client = await connect(context, { authorization: `Bearer ${ALL}` });
      await client.callTool({ name: 'durable_retry_run', arguments: { id: 'r1' } });
      await vi.waitFor(() => expect(events).toHaveLength(1));
      expect((events[0] as { payload: unknown }).payload).toMatchObject({
        devTool: 'durable_retry_run',
        lib: 'durable',
        kind: 'action',
        ok: true,
      });
      const line = log.mock.calls
        .map(([message]) => message)
        .find((message) => (message as { devTool?: string })?.devTool === 'durable_retry_run');
      expect(line).toMatchObject({ lib: 'durable', kind: 'action', ok: true, args: '{"id":"r1"}' });
      expect(JSON.stringify(line)).not.toContain(ALL);
    } finally {
      unsubscribe('aviary:agent:devtools.call', listener);
    }
  });
});
