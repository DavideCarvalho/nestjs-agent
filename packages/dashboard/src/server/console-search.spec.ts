import 'reflect-metadata';
import { AGENT_GOVERNANCE_QUERIES } from '@dudousxd/nestjs-agent-core';
import { type ExecutionContext, Global, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentDashboardModule } from './agent-dashboard.module.js';
import { type ConsoleDecision, authorizeByToken } from './console-authorize.js';
import {
  AVIARY_CONSOLES_SLOT,
  type AviaryConsoleEntry,
  type AviaryConsoleRegistry,
  listVisibleConsoles,
  registerAviaryConsole,
  sanitizeSearchHits,
  searchConsoles,
  withAviaryProbe,
} from './console-switcher.js';

const TOKEN = 'console-token-123';
const holder = globalThis as Record<symbol, unknown>;

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

const registry = (...entries: AviaryConsoleEntry[]): AviaryConsoleRegistry => ({
  version: 1,
  entries,
});

/** A context over a plain request object, so a test can read what the switcher set on it. */
function contextOver(req: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({}) }),
    getType: () => 'http',
  } as unknown as ExecutionContext;
}

const hit = (id: string) => ({ title: `hit ${id}`, href: `/${id}` });

beforeEach(() => {
  delete holder[AVIARY_CONSOLES_SLOT];
});

afterEach(() => {
  vi.useRealTimers();
});

describe('searchConsoles', () => {
  it('searches this console without its authorize, and the others the viewer may open', async () => {
    const selfAuthorize = vi.fn(deny);
    const result = await searchConsoles(
      registry(
        entry({ id: 'agent', order: 30, authorize: selfAuthorize, search: async () => [hit('a')] }),
        entry({ id: 'durable', order: 10, icon: 'workflow', search: async () => [hit('d')] }),
        entry({ id: 'media', authorize: deny, search: async () => [hit('m')] }),
        entry({ id: 'telescope' }), // no search
      ),
      'agent',
      contextOver({}),
      '  run-1  ',
    );
    expect(selfAuthorize).not.toHaveBeenCalled();
    expect(result).toEqual({
      version: 1,
      q: 'run-1',
      partial: false,
      results: [
        { id: 'durable', title: 'durable', icon: 'workflow', hits: [hit('d')] },
        { id: 'agent', title: 'agent', icon: 'generic', hits: [hit('a')] },
      ],
    });
  });

  it('answers for one console only when asked (`console=<id>`), still behind its gate', async () => {
    const asked: string[] = [];
    const reg = registry(
      entry({
        id: 'agent',
        search: async () => {
          asked.push('agent');
          return [hit('thread')];
        },
      }),
      entry({
        id: 'media',
        search: async () => {
          asked.push('media');
          return [hit('a.png')];
        },
      }),
      entry({ id: 'durable', authorize: deny, search: async () => [hit('run')] }),
    );
    const media = await searchConsoles(reg, 'agent', contextOver({}), 'x', { only: 'media' });
    expect(media.results.map((r) => r.id)).toEqual(['media']);
    expect(asked).toEqual(['media']);
    const self = await searchConsoles(reg, 'agent', contextOver({}), 'x', { only: 'agent' });
    expect(self.results.map((r) => r.id)).toEqual(['agent']);
    expect(
      (await searchConsoles(reg, 'agent', contextOver({}), 'x', { only: 'durable' })).results,
    ).toEqual([]);
    expect(
      (await searchConsoles(reg, 'agent', contextOver({}), 'x', { only: 'nope' })).results,
    ).toEqual([]);
  });

  it('passes the query and the limit, keeps 5 hits, and drops unsafe ones', async () => {
    const search = vi.fn(async () => [
      { title: 'evil', href: '//evil.test' },
      { title: 'url', href: 'https://x.test' },
      ...Array.from({ length: 9 }, (_, i) => hit(`ok${i}`)),
    ]);
    const result = await searchConsoles(
      registry(entry({ id: 'durable', search })),
      'agent',
      contextOver({}),
      'x',
    );
    expect(search).toHaveBeenCalledWith(expect.anything(), 'x', 5);
    expect(result.results[0]?.hits.map((h) => h.href)).toEqual([
      '/ok0',
      '/ok1',
      '/ok2',
      '/ok3',
      '/ok4',
    ]);
  });

  it('gives each console 300 ms (authorize, then search) and marks a late or failing one partial', async () => {
    vi.useFakeTimers();
    const pending = searchConsoles(
      registry(
        entry({ id: 'fast', search: async () => [hit('f')] }),
        entry({
          id: 'slowgate',
          authorize: () => new Promise(() => {}),
          search: async () => [hit('x')],
        }),
        entry({ id: 'slowsearch', search: () => new Promise(() => {}) }),
        entry({ id: 'broken', search: async () => Promise.reject(new Error('down')) }),
      ),
      'agent',
      contextOver({}),
      'q',
    );
    await vi.advanceTimersByTimeAsync(301);
    await vi.advanceTimersByTimeAsync(301);
    const result = await pending;
    expect(result.partial).toBe(true);
    expect(result.results.map((group) => group.id)).toEqual(['fast']);
  });

  it('a denial is not partial', async () => {
    const result = await searchConsoles(
      registry(entry({ id: 'media', authorize: deny, search: async () => [hit('m')] })),
      'agent',
      contextOver({}),
      'q',
    );
    expect(result).toMatchObject({ results: [], partial: false });
  });

  it('runs nothing for an empty query', async () => {
    const search = vi.fn(async () => [hit('x')]);
    const result = await searchConsoles(
      registry(entry({ id: 'durable', search })),
      'agent',
      contextOver({}),
      '   ',
    );
    expect(search).not.toHaveBeenCalled();
    expect(result).toEqual({ version: 1, q: '', results: [], partial: false });
  });
});

describe('the probe marker', () => {
  it('is never set while a search runs, this console’s or another’s', async () => {
    const req: Record<string, unknown> = {};
    const seen: unknown[] = [];
    const search = async () => {
      seen.push(req.aviaryProbe);
      return [hit('x')];
    };
    await searchConsoles(
      registry(entry({ id: 'agent', search }), entry({ id: 'durable', search })),
      'agent',
      contextOver(req),
      'q',
    );
    expect(seen).toEqual([undefined, undefined]);
  });

  it('is set on the request while another console’s authorize runs, and removed after', async () => {
    const req: Record<string, unknown> = {};
    const seen: unknown[] = [];
    const authorize = async (ctx: ExecutionContext): Promise<ConsoleDecision> => {
      seen.push(ctx.switchToHttp().getRequest<{ aviaryProbe?: boolean }>().aviaryProbe);
      return { allowed: true };
    };
    await listVisibleConsoles(
      registry(entry({ id: 'durable', authorize })),
      'agent',
      contextOver(req),
    );
    await searchConsoles(
      registry(entry({ id: 'durable', authorize, search: async () => [] })),
      'agent',
      contextOver(req),
      'q',
    );
    expect(seen).toEqual([true, true]);
    expect('aviaryProbe' in req).toBe(false);
  });

  it('leaves a marker someone else set', async () => {
    const req: Record<string, unknown> = { aviaryProbe: true };
    await withAviaryProbe(contextOver(req), async () => undefined);
    expect(req.aviaryProbe).toBe(true);
  });
});

describe('sanitizeSearchHits', () => {
  it('keeps titled same-origin hits and their subtitles', () => {
    expect(
      sanitizeSearchHits(
        [
          { title: 'a', subtitle: 's', href: '/a' },
          { title: '', href: '/b' },
          { title: 'c', href: 'javascript:alert(1)' },
          { title: 'd', href: '/\\evil.test' },
          { title: 'e', href: '/e\u0000x' },
          'junk',
        ],
        5,
      ),
    ).toEqual([{ title: 'a', subtitle: 's', href: '/a' }]);
  });
});

// ── HTTP: the agent console's own search ──────────────────────────────────────

const run = {
  runId: 'run-1',
  threadId: 'th-1',
  actorRef: 'u1',
  agentName: 'support',
  status: 'completed',
  durationMs: 10,
  ttftMs: null,
  costUsd: null,
  modelId: null,
  errorCode: null,
  errorMessage: null,
  retries: 0,
  startedAt: '2026-11-12T10:00:00.000Z',
};
const thread = {
  threadId: 'th-9',
  title: 'Refund for order 42',
  actorRef: 'u1',
  messageCount: 3,
  totalTokens: 10,
  lastActivityAt: '2026-11-11T10:00:00.000Z',
};

const queries = {
  runDetail: vi.fn(async (id: string) =>
    id === 'run-1'
      ? { run, thread: { threadId: 'th-1', title: 't', actorRef: 'u1' }, toolCalls: [] }
      : null,
  ),
  threadDetail: vi.fn(async () => null),
  threadsPage: vi.fn(async (query: { where?: { title?: string } }) => ({
    rows: query.where?.title === 'refund' ? [thread] : [],
    total: 0,
    page: 1,
    pageSize: 5,
  })),
  runsPage: vi.fn(async () => ({ rows: [], total: 0, page: 1, pageSize: 5 })),
};

@Global()
@Module({
  providers: [{ provide: AGENT_GOVERNANCE_QUERIES, useValue: queries }],
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

describe('GET <api>/consoles/search', () => {
  it('is behind the console’s own authorize', async () => {
    const server = await boot(
      AgentDashboardModule.forRoot({ authorize: authorizeByToken({ token: TOKEN }) }),
    );
    await request(server).get('/ai-gateway/api/consoles/search?q=run-1').expect(401);
  });

  it('finds a run by id and threads by title, linking into the console, with the other consoles', async () => {
    registerAviaryConsole(
      entry({
        id: 'durable',
        order: 10,
        icon: 'workflow',
        title: 'Workflows',
        search: async (_ctx, q) => [{ title: `Run ${q}`, href: `/durable#/runs/${q}` }],
      }),
    );
    const server = await boot(
      AgentDashboardModule.forRoot({
        basePath: '/admin/agents',
        authorize: authorizeByToken({ token: TOKEN }),
      }),
    );
    const byId = await request(server)
      .get('/admin/agents/api/consoles/search?q=run-1')
      .set(bearer)
      .expect(200);
    expect(byId.headers['cache-control']).toBe('private, no-store');
    expect(byId.body).toEqual({
      version: 1,
      q: 'run-1',
      partial: false,
      results: [
        {
          id: 'durable',
          title: 'Workflows',
          icon: 'workflow',
          hits: [{ title: 'Run run-1', href: '/durable#/runs/run-1' }],
        },
        {
          id: 'agent',
          title: 'Agents',
          icon: 'agent',
          hits: [
            {
              title: 'Run run-1',
              subtitle: 'support · completed · 2026-11-12',
              href: '/admin/agents#/runs?run=run-1',
            },
          ],
        },
      ],
    });
    const byTitle = await request(server)
      .get('/admin/agents/api/consoles/search?q=refund')
      .set(bearer)
      .expect(200);
    expect(byTitle.body.results.find((g: { id: string }) => g.id === 'agent')?.hits).toEqual([
      {
        title: 'Refund for order 42',
        subtitle: 'Thread · 3 messages · 2026-11-11',
        href: '/admin/agents#/runs?thread=th-9',
      },
    ]);
  });

  it('answers for one console with `console=<id>` (per-console streaming)', async () => {
    registerAviaryConsole(
      entry({
        id: 'durable',
        order: 10,
        icon: 'workflow',
        title: 'Workflows',
        search: async (_ctx, q) => [{ title: `Run ${q}`, href: `/durable#/runs/${q}` }],
      }),
    );
    const server = await boot(
      AgentDashboardModule.forRoot({ authorize: authorizeByToken({ token: TOKEN }) }),
    );
    const durable = await request(server)
      .get('/ai-gateway/api/consoles/search?q=run-1&console=durable')
      .set(bearer)
      .expect(200);
    expect(durable.body.results.map((g: { id: string }) => g.id)).toEqual(['durable']);
    const agent = await request(server)
      .get('/ai-gateway/api/consoles/search?q=run-1&console=agent')
      .set(bearer)
      .expect(200);
    expect(agent.body.results.map((g: { id: string }) => g.id)).toEqual(['agent']);
  });
});
