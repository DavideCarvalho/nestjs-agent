import 'reflect-metadata';
import {
  AGENT_APPROVAL_PORT,
  AGENT_GOVERNANCE_QUERIES,
  type AgentApprovalPort,
  type AgentGovernanceQueries,
  type GovernancePage,
  type RecentRunRow,
} from '@dudousxd/nestjs-agent-core';
import {
  RedisConsoleActionResponder,
  RedisConsoleApprovalClient,
  type RedisConsoleResponderClient,
} from '@dudousxd/nestjs-agent-transport-redis';
import {
  type ExecutionContext,
  Global,
  type INestApplicationContext,
  Module,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentDashboardModule } from './agent-dashboard.module.js';
import type { AgentConsoleFederation } from './federation.js';

/**
 * Two apps and a hub. Each app has its own store (here: its own in-memory read-model) and its own
 * process, which answers console actions over its Redis prefix through its own approval port. The
 * hub mounts the console with `federation` and has a store and an approval port of its own, which
 * must never see an app's reads or decisions. The "Redis" is one in-process pub/sub with JSON round
 * trips, so this runs without Docker.
 */

class FakeRedis implements RedisConsoleResponderClient {
  private readonly subscribers = new Map<string, Set<(message: string) => void>>();
  private readonly keys = new Set<string>();

  async publish(channel: string, message: string): Promise<void> {
    for (const handler of this.subscribers.get(channel) ?? []) {
      queueMicrotask(() => handler(message));
    }
  }

  async subscribe(channel: string, onMessage: (message: string) => void) {
    const set = this.subscribers.get(channel) ?? new Set();
    set.add(onMessage);
    this.subscribers.set(channel, set);
    return async () => {
      set.delete(onMessage);
    };
  }

  async claim(key: string): Promise<boolean> {
    if (this.keys.has(key)) return false;
    this.keys.add(key);
    return true;
  }
}

function run(runId: string, agentName: string): RecentRunRow {
  return {
    runId,
    threadId: `thread-${runId}`,
    actorRef: 'user:1',
    agentName,
    status: 'completed',
    durationMs: 10,
    ttftMs: null,
    costUsd: null,
    modelId: null,
    errorCode: null,
    errorMessage: null,
    retries: 0,
    startedAt: '2026-11-17T10:00:00.000Z',
    promptHash: null,
    parentRunId: null,
  };
}

/** One app's store: its runs, readable through the governance read-model. */
function storeOf(runs: RecentRunRow[]): AgentGovernanceQueries {
  const queries: Partial<AgentGovernanceQueries> = {
    async runsPage(query): Promise<GovernancePage<RecentRunRow>> {
      return { rows: runs, total: runs.length, page: query.page, pageSize: query.pageSize };
    },
    async runDetail(runId) {
      const found = runs.find((r) => r.runId === runId);
      if (found === undefined) return null;
      return {
        run: found,
        thread: {
          threadId: found.threadId,
          title: '',
          actorRef: found.actorRef,
          messageCount: 0,
          totalTokens: 0,
          lastActivityAt: found.startedAt,
        },
        toolCalls: [],
      } as never;
    },
  };
  return queries as AgentGovernanceQueries;
}

/** An approval port that records what it was asked to decide; `known` tool calls only. */
function recordingPort(known: string[]): AgentApprovalPort & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  const decide = (kind: string) => async (toolCallId: string, opts?: unknown) => {
    if (!known.includes(toolCallId)) {
      throw Object.assign(new Error(`tool call ${toolCallId} not found`), { getStatus: () => 404 });
    }
    calls.push([kind, toolCallId, opts]);
  };
  return { calls, approve: decide('approve'), reject: decide('reject') };
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length > 0) await closers.pop()?.();
});

/** An app process: its approval port, answering its console prefix through Nest's lifecycle. */
async function bootApp(redis: FakeRedis, prefix: string, port: AgentApprovalPort) {
  @Module({
    providers: [
      { provide: AGENT_APPROVAL_PORT, useValue: port },
      {
        provide: RedisConsoleActionResponder,
        inject: [AGENT_APPROVAL_PORT],
        useFactory: (approvals: AgentApprovalPort) =>
          new RedisConsoleActionResponder(redis, approvals, { keyPrefix: prefix }),
      },
    ],
  })
  class AppModule {}
  const app: INestApplicationContext = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
  });
  closers.push(() => app.close());
}

/** The hub: its own store and approval port, and the console federating `a` and `b`. */
async function bootHub(
  redis: FakeRedis,
  options: { authorize?: (ctx: ExecutionContext) => unknown; timeoutMs?: number } = {},
) {
  const hubPort = recordingPort(['tc-hub']);
  @Global()
  @Module({
    providers: [
      { provide: AGENT_GOVERNANCE_QUERIES, useValue: storeOf([run('run-hub', 'hub-agent')]) },
      { provide: AGENT_APPROVAL_PORT, useValue: hubPort },
    ],
    exports: [AGENT_GOVERNANCE_QUERIES, AGENT_APPROVAL_PORT],
  })
  class HubStoreModule {}
  const federation: AgentConsoleFederation = {
    localLabel: 'Hub',
    apps: {
      a: {
        label: 'Orders',
        queries: storeOf([run('run-a', 'orders-agent')]),
        approvals: new RedisConsoleApprovalClient(redis, {
          keyPrefix: 'a:agent:console',
          ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        }),
      },
      b: {
        queries: storeOf([run('run-b', 'billing-agent')]),
        approvals: new RedisConsoleApprovalClient(redis, {
          keyPrefix: 'b:agent:console',
          ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        }),
      },
      c: { queries: storeOf([]) },
    },
  };
  @Module({
    imports: [
      HubStoreModule,
      AgentDashboardModule.forRoot({
        authorize: (options.authorize ?? (() => true)) as never,
        federation,
      }),
    ],
  })
  class HubModule {}
  const hub = await NestFactory.create(HubModule, { logger: false, abortOnError: false });
  await hub.init();
  closers.push(() => hub.close());
  return { server: hub.getHttpServer(), hubPort };
}

const API = '/ai-gateway/api';

describe('federated agent console', () => {
  it("reads each app's own store, selected by header or ?app=", async () => {
    const redis = new FakeRedis();
    const { server } = await bootHub(redis);

    const local = await request(server).get(`${API}/runs`).expect(200);
    expect(local.body.data.map((r: RecentRunRow) => r.runId)).toEqual(['run-hub']);

    const a = await request(server).get(`${API}/runs`).set('x-agent-app', 'a').expect(200);
    expect(a.body.data.map((r: RecentRunRow) => r.runId)).toEqual(['run-a']);

    const b = await request(server).get(`${API}/runs?app=b&page=1`).expect(200);
    expect(b.body.data.map((r: RecentRunRow) => r.runId)).toEqual(['run-b']);

    await request(server).get(`${API}/runs/run-a`).set('x-agent-app', 'a').expect(200);
    // Another app's run is not found through this one.
    await request(server).get(`${API}/runs/run-a`).set('x-agent-app', 'b').expect(404);
    await request(server).get(`${API}/runs/run-a`).expect(404);
  });

  it('answers 404 for an unknown app', async () => {
    const { server } = await bootHub(new FakeRedis());
    await request(server).get(`${API}/runs`).set('x-agent-app', 'nope').expect(404);
    await request(server).get(`${API}/runs?app=constructor`).expect(404);
  });

  it('describes the federation, filtered by the viewer grant', async () => {
    const { server } = await bootHub(new FakeRedis(), {
      authorize: () => ({ allowed: true, apps: ['a'] }),
    });
    const view = await request(server).get(`${API}/federation`).expect(200);
    expect(view.body).toEqual({ local: { label: 'Hub' }, apps: [{ name: 'a', label: 'Orders' }] });
    const current = await request(server).get(`${API}/federation?app=a`).expect(200);
    expect(current.body.current).toBe('a');
    // A viewer granted `a` cannot select `b`.
    await request(server).get(`${API}/runs`).set('x-agent-app', 'b').expect(404);
    await request(server).get(`${API}/runs`).set('x-agent-app', 'a').expect(200);
  });

  it('runs an approval on the selected app only, never on the hub', async () => {
    const redis = new FakeRedis();
    const portA = recordingPort(['tc-a']);
    const portB = recordingPort(['tc-b']);
    await bootApp(redis, 'a:agent:console', portA);
    await bootApp(redis, 'b:agent:console', portB);
    const { server, hubPort } = await bootHub(redis);

    await request(server)
      .post(`${API}/approvals/tc-a`)
      .set('x-agent-app', 'a')
      .send({ approved: false, reason: 'not now' })
      .expect(204);
    expect(portA.calls).toEqual([['reject', 'tc-a', { reason: 'not now' }]]);
    expect(portB.calls).toEqual([]);
    expect(hubPort.calls).toEqual([]);

    // The app's own answer comes back: `b` does not know `tc-a`.
    await request(server)
      .post(`${API}/approvals/tc-a`)
      .set('x-agent-app', 'b')
      .send({ approved: true })
      .expect(404);

    // No app selected: the hub's own port, as before.
    await request(server).post(`${API}/approvals/tc-hub`).send({ approved: true }).expect(204);
    expect(hubPort.calls).toEqual([['approve', 'tc-hub', {}]]);
    expect(portA.calls).toHaveLength(1);
  });

  it('answers 504 when the app does not answer, 501 without `approvals`', async () => {
    const { server } = await bootHub(new FakeRedis(), { timeoutMs: 30 });
    await request(server)
      .post(`${API}/approvals/tc-a`)
      .set('x-agent-app', 'a')
      .send({ approved: true })
      .expect(504);
    await request(server)
      .post(`${API}/approvals/tc-c`)
      .set('x-agent-app', 'c')
      .send({ approved: true })
      .expect(501);
  });

  it("answers 501 for what only the hub's own process serves", async () => {
    const { server } = await bootHub(new FakeRedis());
    await request(server).get(`${API}/stream?app=a`).expect(501);
    await request(server).get(`${API}/pricing`).set('x-agent-app', 'a').expect(501);
    await request(server)
      .post(`${API}/pricing`)
      .set('x-agent-app', 'a')
      .send({ modelId: 'm', inputPricePer1m: 1, outputPricePer1m: 1 })
      .expect(501);
    const tenancy = await request(server).get(`${API}/tenancy`).set('x-agent-app', 'a');
    expect(tenancy.body).toMatchObject({ enabled: false });
  });

  it('refuses a federation app without `queries` at boot', () => {
    expect(() =>
      AgentDashboardModule.forRoot({ federation: { apps: { x: {} as never } } }),
    ).toThrow(/needs `queries`/);
  });
});
