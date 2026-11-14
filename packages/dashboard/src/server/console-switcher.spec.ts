import 'reflect-metadata';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENT_GOVERNANCE_QUERIES } from '@dudousxd/nestjs-agent-core';
import { type ExecutionContext, Global, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentDashboardModule } from './agent-dashboard.module.js';
import { type AgentShellOptions, AgentUiController } from './agent-ui.controller.js';
import { type ConsoleDecision, authorizeByToken } from './console-authorize.js';
import {
  AVIARY_CONSOLES_SLOT,
  type AviaryConsoleEntry,
  type AviaryConsoleRegistry,
  consoleSwitcherConfig,
  isSameOriginPath,
  listVisibleConsoles,
  readAviaryConsoles,
  registerAviaryConsole,
} from './console-switcher.js';

const TOKEN = 'console-token-123';
const holder = globalThis as Record<symbol, unknown>;
const context = {} as ExecutionContext;

const allow = async (): Promise<ConsoleDecision> => ({ allowed: true });
const deny = async (): Promise<ConsoleDecision> => ({ allowed: false, reason: 'forbidden' });

function entry(overrides: Partial<AviaryConsoleEntry> & { id: string }): AviaryConsoleEntry {
  return {
    title: overrides.id,
    icon: 'generic',
    path: `/${overrides.id}`,
    order: 50,
    authorize: allow,
    ...overrides,
  };
}

function registry(...entries: AviaryConsoleEntry[]): AviaryConsoleRegistry {
  return { version: 1, entries };
}

beforeEach(() => {
  delete holder[AVIARY_CONSOLES_SLOT];
});

afterEach(() => {
  vi.useRealTimers();
});

describe('registerAviaryConsole', () => {
  it('creates the registry when absent, and the returned function removes the entry', () => {
    const remove = registerAviaryConsole(entry({ id: 'agent' }));
    expect(readAviaryConsoles()?.entries.map((e) => e.id)).toEqual(['agent']);
    remove?.();
    expect(readAviaryConsoles()?.entries).toEqual([]);
  });

  it('appends to a registry another console created (two copies, one registry)', () => {
    const existing = registry(entry({ id: 'durable' }));
    holder[AVIARY_CONSOLES_SLOT] = existing;
    registerAviaryConsole(entry({ id: 'agent' }));
    expect(holder[AVIARY_CONSOLES_SLOT]).toBe(existing);
    expect(existing.entries.map((e) => e.id)).toEqual(['durable', 'agent']);
  });

  it('leaves a registry of another version alone', () => {
    const future = { version: 2, entries: [] };
    holder[AVIARY_CONSOLES_SLOT] = future;
    expect(registerAviaryConsole(entry({ id: 'agent' }))).toBeUndefined();
    expect(future.entries).toEqual([]);
  });

  it('warns and skips a duplicate id', () => {
    const warn = vi.fn();
    registerAviaryConsole(entry({ id: 'agent' }));
    expect(registerAviaryConsole(entry({ id: 'agent', title: 'Other' }), { warn })).toBeUndefined();
    expect(warn).toHaveBeenCalledWith('console id "agent" is already registered');
    expect(readAviaryConsoles()?.entries).toHaveLength(1);
  });

  it('rejects a bad id or a path that is not same-origin', () => {
    expect(() => registerAviaryConsole(entry({ id: 'Agent' }))).toThrow(/id/);
    expect(() => registerAviaryConsole(entry({ id: 'agent', path: '//evil.test' }))).toThrow(
      /path/,
    );
    expect(() => registerAviaryConsole(entry({ id: 'agent', path: 'https://x.test' }))).toThrow(
      /path/,
    );
  });
});

describe('isSameOriginPath', () => {
  it('accepts a plain absolute path, rejects other origins, backslashes and control characters', () => {
    expect(isSameOriginPath('/agent#/threads/1')).toBe(true);
    for (const bad of [
      '//evil.test',
      'https://evil.test',
      '/\\evil.test',
      '/a\u0007b',
      '/a\nb',
      '/a\u007fb',
      'x',
      1,
    ]) {
      expect(isSameOriginPath(bad)).toBe(false);
    }
  });
});

describe('consoleSwitcherConfig', () => {
  it('is absent when this console is alone or not registered, and counts the others', () => {
    expect(consoleSwitcherConfig('agent', '/a/consoles')).toBeUndefined();
    registerAviaryConsole(entry({ id: 'durable' }));
    expect(consoleSwitcherConfig('agent', '/a/consoles')).toBeUndefined();
    registerAviaryConsole(entry({ id: 'agent' }));
    expect(consoleSwitcherConfig('agent', '/a/consoles')).toEqual({
      endpoint: '/a/consoles',
      others: 1,
    });
  });
});

describe('listVisibleConsoles', () => {
  it('lists the allowed others by order then id, never self, with href = path', async () => {
    const result = await listVisibleConsoles(
      registry(
        entry({ id: 'media', order: 50, icon: 'media', title: 'Media' }),
        entry({ id: 'agent', order: 30, icon: 'agent' }),
        entry({ id: 'telescope', order: 20, icon: 'telescope', title: 'Telescope' }),
        entry({ id: 'durable', order: 10, icon: 'workflow', title: 'Workflows' }),
        entry({ id: 'aaa', order: 50 }),
      ),
      'agent',
      context,
    );
    expect(result).toEqual({
      version: 1,
      current: 'agent',
      consoles: [
        { id: 'durable', title: 'Workflows', icon: 'workflow', href: '/durable' },
        { id: 'telescope', title: 'Telescope', icon: 'telescope', href: '/telescope' },
        { id: 'aaa', title: 'aaa', icon: 'generic', href: '/aaa' },
        { id: 'media', title: 'Media', icon: 'media', href: '/media' },
      ],
    });
  });

  it('hides forbidden, redirectTo, rejecting and throwing entries, and returns no reason', async () => {
    const result = await listVisibleConsoles(
      registry(
        entry({ id: 'ok' }),
        entry({ id: 'forbidden', authorize: deny }),
        entry({
          id: 'redirect',
          authorize: async () => ({
            allowed: false,
            reason: 'unauthenticated',
            redirectTo: '/login',
          }),
        }),
        entry({ id: 'rejects', authorize: () => Promise.reject(new Error('boom')) }),
        entry({
          id: 'throws',
          authorize: () => {
            throw new Error('sync boom');
          },
        }),
      ),
      'agent',
      context,
    );
    expect(result.consoles.map((c) => c.id)).toEqual(['ok']);
    expect(JSON.stringify(result)).not.toMatch(/forbidden|unauthenticated|login|boom/);
  });

  it('passes the request context to each authorize', async () => {
    const authorize = vi.fn(allow);
    await listVisibleConsoles(registry(entry({ id: 'x', authorize })), 'agent', context);
    expect(authorize).toHaveBeenCalledWith(context);
  });

  it('maps an unknown icon to generic and drops an unsafe path', async () => {
    const result = await listVisibleConsoles(
      registry(
        entry({ id: 'odd', icon: 'rocket' as never }),
        entry({ id: 'evil', path: '//evil.test' }),
        entry({ id: 'slash', path: '/\\evil.test' }),
        entry({ id: 'ctl', path: '/ctl\u0007x' }),
      ),
      'agent',
      context,
    );
    expect(result.consoles).toEqual([{ id: 'odd', title: 'odd', icon: 'generic', href: '/odd' }]);
  });

  it('runs every authorize in parallel, each given 300 ms; a slower one is hidden', async () => {
    vi.useFakeTimers();
    const settleAfter = (ms: number, decision: ConsoleDecision) => () =>
      new Promise<ConsoleDecision>((resolve) => setTimeout(() => resolve(decision), ms));
    const pending = listVisibleConsoles(
      registry(
        entry({ id: 'a', order: 1, authorize: settleAfter(250, { allowed: true }) }),
        entry({ id: 'b', order: 2, authorize: settleAfter(280, { allowed: true }) }),
        entry({ id: 'slow', order: 3, authorize: settleAfter(5_000, { allowed: true }) }),
      ),
      'agent',
      context,
    );
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    // In sequence, a + b alone would take 530 ms; in parallel, everything settles by the timeout.
    await vi.advanceTimersByTimeAsync(300);
    expect(settled).toBe(true);
    expect((await pending).consoles.map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('answers an empty list without a registry', async () => {
    expect(await listVisibleConsoles(undefined, 'agent', context)).toEqual({
      version: 1,
      current: 'agent',
      consoles: [],
    });
  });
});

// ── HTTP ───────────────────────────────────────────────────────────────────

@Global()
@Module({
  providers: [{ provide: AGENT_GOVERNANCE_QUERIES, useValue: {} }],
  exports: [AGENT_GOVERNANCE_QUERIES],
})
class HostStoreModule {}

let close: (() => Promise<void>) | undefined;

async function boot(dashboard: ReturnType<typeof AgentDashboardModule.forRoot>) {
  @Module({ imports: [HostStoreModule, dashboard] })
  class HostRootModule {}
  const app = await NestFactory.create(HostRootModule, { logger: false, abortOnError: false });
  await app.init();
  close = () => app.close();
  return app.getHttpServer();
}

afterEach(async () => {
  await close?.();
  close = undefined;
});

const bearer = { authorization: `Bearer ${TOKEN}` };

describe('the agent console in the switcher', () => {
  it('registers itself at its page path when mounted, gated by its own authorize, and leaves on close', async () => {
    await boot(
      AgentDashboardModule.forRoot({
        basePath: '/admin/agents',
        authorize: authorizeByToken({ token: TOKEN }),
      }),
    );
    const [agent] = readAviaryConsoles()?.entries ?? [];
    expect(agent).toMatchObject({
      id: 'agent',
      title: 'Agents',
      icon: 'agent',
      order: 30,
      path: '/admin/agents',
    });
    const ctx = (headers: Record<string, string>) =>
      ({
        switchToHttp: () => ({ getRequest: () => ({ headers }), getResponse: () => ({}) }),
        getType: () => 'http',
        getHandler: () => () => undefined,
        getClass: () => class {},
      }) as unknown as ExecutionContext;
    expect((await agent?.authorize(ctx(bearer)))?.allowed).toBe(true);
    expect((await agent?.authorize(ctx({})))?.allowed).toBe(false);
    await close?.();
    close = undefined;
    expect(readAviaryConsoles()?.entries).toEqual([]);
  });

  it('does not register with routes: false', async () => {
    await boot(AgentDashboardModule.forRoot({ routes: false, authorize: () => true }));
    expect(readAviaryConsoles()?.entries ?? []).toEqual([]);
  });

  it('GET <api>/consoles is behind the console’s own authorize', async () => {
    registerAviaryConsole(
      entry({ id: 'durable', order: 10, icon: 'workflow', title: 'Workflows' }),
    );
    const server = await boot(
      AgentDashboardModule.forRoot({ authorize: authorizeByToken({ token: TOKEN }) }),
    );
    const denied = await request(server).get('/ai-gateway/api/consoles').expect(401);
    expect(denied.body).toEqual({ error: 'unauthenticated' });
  });

  it('GET <api>/consoles lists the others the viewer may open, private and uncached', async () => {
    registerAviaryConsole(
      entry({ id: 'durable', order: 10, icon: 'workflow', title: 'Workflows' }),
    );
    registerAviaryConsole(entry({ id: 'media', order: 50, authorize: deny }));
    registerAviaryConsole(
      entry({
        id: 'telescope',
        order: 20,
        icon: 'telescope',
        title: 'Telescope',
        // Sees the same request the agent console was asked with.
        authorize: async (ctx) => ({
          allowed:
            ctx.switchToHttp().getRequest<{ headers: Record<string, string> }>().headers[
              'x-telescope'
            ] === 'yes',
        }),
      }),
    );
    const server = await boot(
      AgentDashboardModule.forRoot({
        apiBasePath: '/api/agents',
        authorize: authorizeByToken({ token: TOKEN }),
      }),
    );
    const res = await request(server)
      .get('/api/agents/consoles')
      .set(bearer)
      .set('x-telescope', 'yes')
      .expect(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.body).toEqual({
      version: 1,
      current: 'agent',
      consoles: [
        { id: 'durable', title: 'Workflows', icon: 'workflow', href: '/durable' },
        { id: 'telescope', title: 'Telescope', icon: 'telescope', href: '/telescope' },
      ],
    });
    const without = await request(server).get('/api/agents/consoles').set(bearer).expect(200);
    expect(without.body.consoles.map((c: { id: string }) => c.id)).toEqual(['durable']);
  });
});

describe('the shell’s config block', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-shell-'));
    mkdirSync(join(dir, 'assets'));
    writeFileSync(
      join(dir, 'index.html'),
      '<!doctype html><html><head><script type="module" src="/ai-gateway/assets/app.js" nonce="x"></script></head><body></body></html>',
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function shell(
    options: AgentShellOptions = {},
    request: Record<string, unknown> = {},
  ): Promise<{ html: string; config: Record<string, unknown> }> {
    const controller = Object.assign(new AgentUiController('/agents', '/api/agents', options), {
      dir,
    }) as unknown as AgentUiController;
    const html = await controller.index(
      { headers: {}, originalUrl: '/agents', ...request },
      {
        status: () => undefined,
        setHeader: () => undefined,
      },
    );
    const match = html.match(
      /<script type="application\/json" id="agent-dashboard-config">([^<]*)<\/script>/,
    );
    if (!match?.[1]) throw new Error('no config block');
    return { html, config: JSON.parse(match[1]) as Record<string, unknown> };
  }

  const search = { endpoint: '/api/agents/consoles/search', self: 'agent' };

  it('has no switcher while the agent console is alone, but still its own ⌘K search', async () => {
    registerAviaryConsole(entry({ id: 'agent', path: '/agents' }));
    expect((await shell()).config).toEqual({ apiBase: '/api/agents', search });
  });

  it('has neither switcher nor search when the console is not registered', async () => {
    expect((await shell()).config).toEqual({ apiBase: '/api/agents' });
  });

  it('carries the endpoint and how many others are registered, as data (CSP-safe)', async () => {
    registerAviaryConsole(entry({ id: 'agent', path: '/agents' }));
    registerAviaryConsole(entry({ id: 'durable' }));
    registerAviaryConsole(entry({ id: 'media' }));
    const { html, config } = await shell();
    expect(config).toEqual({
      apiBase: '/api/agents',
      switcher: { endpoint: '/api/agents/consoles', others: 2 },
      search,
    });
    // The block is JSON data, not script: a `script-src 'self' 'nonce-x'` page still parses it.
    expect(html).toContain('<script type="application/json" id="agent-dashboard-config">');
    expect(html).toContain('src="/agents/assets/app.js"');
  });

  it('reads the viewer from request.user, and signOut from the option, escaped like the rest', async () => {
    const { html, config } = await shell(
      { signOut: { action: '/logout', csrfToken: () => 'tok' } },
      { user: { fullName: '</script><b>', email: 'ann@x.test', roles: [{ name: 'admin' }] } },
    );
    expect(html.split('</script>').length).toBe(4);
    expect(config).toEqual({
      apiBase: '/api/agents',
      viewer: { label: '</script><b>', email: 'ann@x.test', role: 'admin' },
      signOut: { action: '/logout', csrfToken: 'tok' },
    });
  });

  it('uses the viewer option over request.user, and an announced sign-out as a fallback', async () => {
    (globalThis as Record<symbol, unknown>)[AVIARY_CONSOLES_SLOT] = {
      version: 1,
      entries: [],
      account: { signOut: { href: '/account/logout' } },
    };
    const { config } = await shell(
      { viewer: async () => ({ label: 'Ops', role: 'support' }) },
      { user: { email: 'ignored@x.test' } },
    );
    expect(config).toEqual({
      apiBase: '/api/agents',
      viewer: { label: 'Ops', role: 'support' },
      signOut: { href: '/account/logout' },
    });
    expect((await shell({ signOut: false })).config).toEqual({ apiBase: '/api/agents' });
  });
});
