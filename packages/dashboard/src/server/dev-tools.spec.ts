import 'reflect-metadata';
import { AGENT_GOVERNANCE_QUERIES } from '@dudousxd/nestjs-agent-core';
import { type ExecutionContext, Global, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentDashboardModule } from './agent-dashboard.module.js';
import { authorizeByToken } from './console-authorize.js';
import type { AgentDevTool } from './dev-tools.js';

const SLOT = Symbol.for('@dudousxd/aviary:dev-tools');
const TOKEN = 'console-token-123';

const RUN = {
  runId: 'r1',
  threadId: 't1',
  actorRef: 'user:1',
  agentName: 'support',
  status: 'failed',
  durationMs: 10,
  ttftMs: null,
  costUsd: null,
};

const queries = {
  runsPage: vi.fn(async (query: { page: number; pageSize: number }) => ({
    rows: [RUN],
    total: 3,
    page: query.page,
    pageSize: query.pageSize,
  })),
  runDetail: vi.fn(async (id: string) =>
    id === 'r1'
      ? {
          run: RUN,
          thread: { threadId: 't1', actorRef: 'user:1', title: null },
          toolCalls: [],
        }
      : null,
  ),
  threadDetail: vi.fn(async () => ({
    thread: { threadId: 't1', actorRef: 'user:1' },
    deleted: false,
    usage: {},
    runs: [],
    runTotal: 0,
    messages: [
      {
        messageId: 'm1',
        role: 'assistant',
        content: 'y'.repeat(5000),
        truncated: false,
        agentName: null,
        toolCallCount: 0,
        createdAt: '2026-11-12T00:00:00.000Z',
      },
    ],
  })),
  toolStats: vi.fn(async () => [{ toolName: 'search', calls: 1 }]),
};

@Global()
@Module({
  providers: [{ provide: AGENT_GOVERNANCE_QUERIES, useValue: queries }],
  exports: [AGENT_GOVERNANCE_QUERIES],
})
class HostStoreModule {}

interface SlotLib {
  lib: string;
  title: string;
  authorize(context: ExecutionContext): Promise<unknown>;
  tools: AgentDevTool[];
}

const slotLibs = () =>
  ((globalThis as Record<symbol, { libs: SlotLib[] } | undefined>)[SLOT]?.libs ?? []) as SlotLib[];

let close: (() => Promise<void>) | undefined;

async function boot(dashboard: ReturnType<typeof AgentDashboardModule.forRoot>) {
  @Module({ imports: [HostStoreModule, dashboard] })
  class HostRootModule {}
  const app = await NestFactory.create(HostRootModule, { logger: false, abortOnError: false });
  await app.init();
  close = () => app.close();
  return app.getHttpServer();
}

function tool(name: string): AgentDevTool {
  const found = slotLibs()
    .find((lib) => lib.lib === 'agent')
    ?.tools.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`no tool ${name}`);
  return found;
}

function httpContext(headers: Record<string, string>): ExecutionContext {
  const req = { headers };
  return {
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({}) }),
    getType: () => 'http',
    getHandler: () => () => undefined,
    getClass: () => class {},
  } as unknown as ExecutionContext;
}

beforeEach(() => {
  delete (globalThis as Record<symbol, unknown>)[SLOT];
});

afterEach(async () => {
  await close?.();
  close = undefined;
  vi.clearAllMocks();
});

describe('agent dev tools registration', () => {
  it('registers the governance reads when the console is mounted, and removes them on close', async () => {
    await boot(AgentDashboardModule.forRoot({ authorize: authorizeByToken({ token: TOKEN }) }));
    const [agent] = slotLibs();
    expect(agent?.lib).toBe('agent');
    expect(agent?.tools.map((t) => t.name)).toEqual([
      'agent_list_runs',
      'agent_get_run',
      'agent_get_spend',
      'agent_get_tool_stats',
      'agent_get_reliability',
      'agent_list_pending_approvals',
      'agent_list_recent_tool_calls',
    ]);
    expect(agent?.tools.every((t) => t.kind === 'read')).toBe(true);
    await close?.();
    close = undefined;
    expect(slotLibs()).toEqual([]);
  });

  it('is gated by the console’s own resolved authorize', async () => {
    await boot(AgentDashboardModule.forRoot({ authorize: authorizeByToken({ token: TOKEN }) }));
    const [agent] = slotLibs();
    expect(await agent?.authorize(httpContext({ authorization: `Bearer ${TOKEN}` }))).toEqual({
      allowed: true,
      caller: expect.stringMatching(/^token:[0-9a-f]{12}$/),
    });
    expect(await agent?.authorize(httpContext({}))).toEqual({
      allowed: false,
      reason: 'unauthenticated',
    });
  });

  it('registers nothing with routes: false, unless devTools: true', async () => {
    await boot(AgentDashboardModule.forRoot({ routes: false, authorize: () => true }));
    expect(slotLibs()).toEqual([]);
    await close?.();
    close = undefined;
    await boot(
      AgentDashboardModule.forRoot({ routes: false, devTools: true, authorize: () => true }),
    );
    expect(slotLibs().map((lib) => lib.lib)).toEqual(['agent']);
  });

  it('registers nothing with devTools: false', async () => {
    await boot(AgentDashboardModule.forRoot({ devTools: false, authorize: () => true }));
    expect(slotLibs()).toEqual([]);
  });
});

describe('agent dev tools', () => {
  it('agent_list_runs reads what GET runs serves, as { items, next, total }', async () => {
    const server = await boot(AgentDashboardModule.forRoot({ authorize: () => true }));
    const api = await request(server)
      .get('/ai-gateway/api/runs?page=1&size=1&filter[status]=failed')
      .expect(200);
    const result = (await tool('agent_list_runs').run({ status: 'failed', limit: 1 })) as {
      items: unknown[];
      next: number | null;
      total: number;
    };
    expect(result.items).toEqual(api.body.data);
    expect(api.body.meta.total).toBe(3);
    expect(result.next).toBe(2);
    expect(result.total).toBe(3);
    expect(queries.runsPage).toHaveBeenLastCalledWith({
      page: 1,
      pageSize: 1,
      where: { status: 'failed' },
    });
  });

  it('agent_list_runs rejects a malformed day', async () => {
    await boot(AgentDashboardModule.forRoot({ authorize: () => true }));
    await expect(tool('agent_list_runs').run({ from: 'yesterday' })).rejects.toThrow(/YYYY-MM-DD/);
  });

  it('agent_get_run fails for an unknown id, and cuts messages to 2 KB', async () => {
    await boot(AgentDashboardModule.forRoot({ authorize: () => true }));
    await expect(tool('agent_get_run').run({ id: 'nope' })).rejects.toThrow('run nope not found');
    const withMessages = (await tool('agent_get_run').run({
      id: 'r1',
      includeMessages: true,
    })) as { messages: Array<{ content: string }> };
    expect(Buffer.byteLength(withMessages.messages[0]?.content ?? '')).toBeLessThanOrEqual(2048);
    expect(withMessages.messages[0]?.content).toMatch(/…\(truncated, 5000 bytes\)$/);
    expect(await tool('agent_get_run').run({ id: 'r1' })).not.toHaveProperty('messages');
  });

  it('agent_get_tool_stats wraps the console rollup as items', async () => {
    await boot(AgentDashboardModule.forRoot({ authorize: () => true }));
    expect(
      await tool('agent_get_tool_stats').run({ from: '2026-11-01', to: '2026-11-02' }),
    ).toEqual({ items: [{ toolName: 'search', calls: 1 }] });
    expect(queries.toolStats).toHaveBeenCalledWith({ fromDay: '2026-11-01', toDay: '2026-11-02' });
  });
});
