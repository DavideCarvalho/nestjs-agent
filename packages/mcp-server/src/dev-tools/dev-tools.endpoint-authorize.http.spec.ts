import { AgentModule } from '@dudousxd/nestjs-agent';
import { FakeModelProvider, InMemoryAgentStore } from '@dudousxd/nestjs-agent-testing';
import {
  type ExecutionContext,
  type INestApplication,
  Injectable,
  Logger,
  type OnModuleInit,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentMcpServerModule } from '../agent-mcp-server.module.js';
import { BearerTokenActorResolver } from '../bearer-token-actor-resolver.js';
import {
  DEV_TOOLS_SLOT,
  type DevTool,
  type DevToolsDecision,
  type DevToolsLib,
  type DevToolsSlot,
  devToolsSlot,
  registerDevTools,
} from './contract.js';
import type { AgentDevToolsOptions } from './options.js';

function readTool(name: string): DevTool {
  return {
    name,
    kind: 'read',
    description: `${name}.`,
    input: { type: 'object', properties: {} },
    run: async () => ({ items: [], next: null }),
  };
}

/** A lib with no console: it registers without `authorize`, from its own `onModuleInit`. */
const registered: Array<(() => void) | undefined> = [];

@Injectable()
class ResilienceDevTools implements OnModuleInit {
  onModuleInit(): void {
    registered.push(
      registerDevTools({
        lib: 'resilience',
        title: 'Resilience',
        tools: [readTool('resilience_list_circuits')],
      }),
    );
  }
}

/** A lib with a console of its own: only the `x-console: yes` header gets in. */
@Injectable()
class DurableDevTools implements OnModuleInit {
  onModuleInit(): void {
    registered.push(
      registerDevTools({
        lib: 'durable',
        title: 'Durable',
        authorize: async (context: ExecutionContext): Promise<DevToolsDecision> =>
          header(context, 'x-console') === 'yes'
            ? { allowed: true }
            : { allowed: false, reason: 'forbidden' },
        tools: [readTool('durable_list_runs')],
      }),
    );
  }
}

function header(context: ExecutionContext, name: string): string | undefined {
  return context.switchToHttp().getRequest<{ headers: Record<string, string | undefined> }>()
    .headers[name];
}

let app: INestApplication | undefined;
const originalEnv = process.env.NODE_ENV;

beforeEach(() => {
  delete (globalThis as Record<symbol, unknown>)[DEV_TOOLS_SLOT];
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  for (const off of registered.splice(0)) off?.();
  process.env.NODE_ENV = originalEnv;
  vi.restoreAllMocks();
});

async function boot(devTools: AgentDevToolsOptions = {}): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      AgentModule.forRoot({
        model: new FakeModelProvider(() => ({ text: 'ok' })),
        store: new InMemoryAgentStore(),
      }),
      AgentMcpServerModule.forRoot({
        name: 'spec-server',
        version: '1.0.0',
        auth: new BearerTokenActorResolver([]),
        devTools,
      }),
    ],
    providers: [ResilienceDevTools, DurableDevTools],
  }).compile();
  const created = moduleRef.createNestApplication({ logger: false });
  await created.init();
  app = created;
  return created;
}

async function listTools(
  context: INestApplication,
  headers: Record<string, string> = {},
): Promise<{ status: number; names: string[]; body: unknown }> {
  let req = request(context.getHttpServer())
    .post('/mcp/aviary')
    .set('accept', 'application/json, text/event-stream')
    .set('content-type', 'application/json');
  for (const [name, value] of Object.entries(headers)) req = req.set(name, value);
  const res = await req.send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  // The answer comes as one SSE `data:` line.
  const data = /^data: (.+)$/m.exec(res.text ?? '')?.[1];
  const message = (data !== undefined ? JSON.parse(data) : res.body) as {
    result?: { tools?: Array<{ name: string }> };
  };
  const names =
    res.status === 200 ? (message.result?.tools ?? []).map((tool) => tool.name).sort() : [];
  return { status: res.status, names, body: res.body };
}

describe('devTools.authorize: the gate of libs without a console', () => {
  it('gates a console-less lib, once per request, and never widens a lib with a console', async () => {
    const authorize = vi.fn(async (context: ExecutionContext) =>
      header(context, 'x-dev') === 'yes'
        ? { allowed: true as const }
        : { allowed: false as const, reason: 'unauthenticated' as const },
    );
    const context = await boot({ authorize });

    expect(await listTools(context, { 'x-dev': 'yes' })).toMatchObject({
      status: 200,
      names: ['resilience_list_circuits'],
    });
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(await listTools(context, { 'x-dev': 'yes', 'x-console': 'yes' })).toMatchObject({
      names: ['durable_list_runs', 'resilience_list_circuits'],
    });
    expect(await listTools(context, { 'x-console': 'yes' })).toMatchObject({
      names: ['durable_list_runs'],
    });
    const refused = await listTools(context);
    expect(refused.status).toBe(401);
    expect(refused.body).toEqual({ error: 'unauthenticated' });
  });

  it('takes the console forms: a class with authorize()', async () => {
    @Injectable()
    class DevGate {
      authorize(context: ExecutionContext) {
        return header(context, 'x-dev') === 'yes';
      }
    }
    const context = await boot({ authorize: DevGate });
    expect((await listTools(context, { 'x-dev': 'yes' })).names).toEqual([
      'resilience_list_circuits',
    ]);
    expect((await listTools(context, { 'x-dev': 'no' })).status).toBe(403);
  });

  it('without it: open outside production, with one boot warning naming the libs', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    process.env.NODE_ENV = 'development';
    const context = await boot();
    const warnings = warn.mock.calls
      .map(([message]) => String(message))
      .filter((message) => message.includes('have no authorize'));
    expect(warnings).toEqual([
      '[@dudousxd/nestjs-agent-mcp-server] dev tools for resilience have no authorize: open outside production, denied in production. Set devTools.authorize in AgentMcpServerModule.forRoot().',
    ]);
    expect((await listTools(context)).names).toEqual(['resilience_list_circuits']);
  });

  it('without it: denied in production', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    process.env.NODE_ENV = 'production';
    const context = await boot();
    expect((await listTools(context)).status).toBe(403);
    expect((await listTools(context, { 'x-console': 'yes' })).names).toEqual(['durable_list_runs']);
  });

  it('warns about nothing when every lib has a console gate', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const moduleRef = await Test.createTestingModule({
      imports: [
        AgentModule.forRoot({
          model: new FakeModelProvider(() => ({ text: 'ok' })),
          store: new InMemoryAgentStore(),
        }),
        AgentMcpServerModule.forRoot({
          name: 'spec-server',
          version: '1.0.0',
          auth: new BearerTokenActorResolver([]),
        }),
      ],
      providers: [DurableDevTools],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    expect(warn.mock.calls.some(([message]) => String(message).includes('have no authorize'))).toBe(
      false,
    );
  });
});

describe('the slot advertises endpoint-authorize', () => {
  it('only once an endpoint serves it; a lib without authorize stays out of a slot nobody serves', () => {
    const slot = devToolsSlot() as DevToolsSlot;
    expect(slot.supports?.('endpoint-authorize')).toBeUndefined();
    const lib: DevToolsLib = {
      lib: 'filter',
      title: 'Filter',
      tools: [readTool('filter_get_spec')],
    };
    expect(registerDevTools(lib)).toBeUndefined();
    expect(slot.libs).toEqual([]);
  });

  it('is set before any module registers', async () => {
    await boot({ authorize: () => true });
    const slot = devToolsSlot();
    expect(slot.supports?.('endpoint-authorize')).toBe(true);
    expect(slot.supports?.('something-else')).toBe(false);
  });

  it('keeps the features another endpoint copy advertised', async () => {
    const slot = devToolsSlot() as DevToolsSlot & { supports?: (feature: string) => boolean };
    slot.supports = (feature) => feature === 'future-feature';
    await boot({ authorize: () => true });
    expect(slot.supports?.('future-feature')).toBe(true);
    expect(slot.supports?.('endpoint-authorize')).toBe(true);
    expect(slot.libs.map((lib) => lib.lib).sort()).toEqual(['durable', 'resilience']);
  });
});
