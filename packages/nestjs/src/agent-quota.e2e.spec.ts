import type { AgentStore, QuotaProvider, QuotaReport } from '@dudousxd/nestjs-agent-core';
import { FakeModelProvider, InMemoryAgentStore } from '@dudousxd/nestjs-agent-testing';
import { Injectable } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentModule } from './agent.module.js';
import type { AgentModuleOptions } from './agent.options.js';
import { Agent } from './decorator/agent.decorator.js';
import { LedgerQuotaProvider } from './ledger-quota-provider.js';
import { HeaderActorResolver } from './resolver/header-actor-resolver.js';

@Agent({ name: 'default', systemPrompt: 'quota test agent', model: 'fake-1' })
@Injectable()
class DefaultAgent {}

let app: NestExpressApplication | undefined;

async function boot(options: Partial<AgentModuleOptions> = {}) {
  let turns = 0;
  const moduleRef = await Test.createTestingModule({
    imports: [
      AgentModule.forRoot({
        model: new FakeModelProvider(() => {
          turns += 1;
          return { text: 'ok' };
        }),
        store: new InMemoryAgentStore(),
        actorResolver: new HeaderActorResolver(),
        defaultAgent: 'default',
        ...options,
      }),
    ],
    providers: [DefaultAgent],
  }).compile();
  const testApp = moduleRef.createNestApplication<NestExpressApplication>();
  await testApp.init();
  app = testApp;
  return { server: testApp.getHttpServer(), turns: () => turns };
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

const chat = (server: unknown) =>
  request(server as Parameters<typeof request>[0])
    .post('/agent/chat')
    .set('x-actor-id', 'u1')
    .send({ message: 'hi' });
const quota = (server: unknown) =>
  request(server as Parameters<typeof request>[0])
    .get('/agent/quota')
    .set('x-actor-id', 'u1');

describe('GET /agent/quota', () => {
  it('reports the day and month windows off the ledger, unblocked, with no ceilings', async () => {
    const { server } = await boot();
    await chat(server);

    const res = await quota(server);

    expect(res.status).toBe(200);
    expect(res.body.blocked).toBeUndefined();
    expect(res.body.windows.map((w: { period: string }) => w.period)).toEqual(['day', 'month']);
    const [day, month] = res.body.windows;
    expect(day.usedTokens).toBeGreaterThan(0);
    expect(month.usedTokens).toBe(day.usedTokens);
    expect(day).not.toHaveProperty('limitTokens');
    expect(typeof day.resetsAt).toBe('string');
  });

  it('warns past warnAt: the threshold on every window, the warning on the report', async () => {
    const { server } = await boot({ quota: { limits: { day: { tokens: 5000 } }, warnAt: 0.0001 } });
    await chat(server);

    const res = await quota(server);

    expect(res.body.windows[0]).toMatchObject({ period: 'day', limitTokens: 5000, warnAt: 0.0001 });
    expect(res.body.blocked).toBeUndefined();
    expect(res.body.warning).toMatchObject({ period: 'day' });
    expect(res.body.warning.ratio).toBeGreaterThan(0);
  });

  it('carries configured ceilings on the windows', async () => {
    const { server } = await boot({ quota: { limits: { day: { tokens: 5000 } } } });
    const res = await quota(server);
    expect(res.body.windows[0]).toMatchObject({ period: 'day', limitTokens: 5000 });
  });

  it('no longer serves GET /agent/quota/today', async () => {
    const { server } = await boot();
    const res = await request(server).get('/agent/quota/today').set('x-actor-id', 'u1');
    expect(res.status).toBe(404);
  });
});

describe('the send gate', () => {
  it('refuses a send once a configured window is exhausted, naming the window', async () => {
    const { server, turns } = await boot({ quota: { limits: { month: { tokens: 1 } } } });
    expect((await chat(server)).status).toBe(201);

    const report = await quota(server);
    expect(report.body.blocked).toMatchObject({ period: 'month' });
    expect(report.body.windows[1]).toMatchObject({ period: 'month', limitTokens: 1 });

    const refused = await chat(server);
    expect(refused.status).toBe(429);
    expect(refused.body).toMatchObject({ code: 'quota_exceeded', period: 'month' });
    expect(turns()).toBe(1);
  });

  it("asks the host's own provider, and refuses on its word", async () => {
    const blocked: QuotaReport = {
      windows: [{ period: 'month', usedTokens: 0, usedUsd: 12, limitUsd: 10 }],
      blocked: { period: 'month', reason: 'Monthly AI budget reached' },
    };
    const provider: QuotaProvider = { report: async () => blocked };
    const { server, turns } = await boot({ quota: provider });

    expect((await quota(server)).body).toEqual(blocked);
    const refused = await chat(server);
    expect(refused.status).toBe(429);
    expect(refused.body.message).toBe('Monthly AI budget reached');
    expect(turns()).toBe(0);
  });

  it('does not gate on the default report when nothing was configured', async () => {
    const { server } = await boot();
    expect((await chat(server)).status).toBe(201);
    expect((await chat(server)).status).toBe(201);
  });
});

describe('LedgerQuotaProvider', () => {
  it('blocks on spend as well as tokens, and leaves out the month without a range read', async () => {
    const store = new InMemoryAgentStore();
    const thread = await store.createThread({ actor: { id: 'u1' } });
    await store.recordUsage({
      threadId: thread.id,
      actorRef: 'u1',
      modelId: 'm',
      purpose: 'chat',
      usage: { inputTokens: 1, outputTokens: 1 },
      costUsd: 0.5,
    });
    const report = await new LedgerQuotaProvider(store, { day: { usd: 0.25 } }).report({
      actor: { id: 'u1' },
    });
    expect(report.blocked?.period).toBe('day');
    expect(report.windows[0]).toMatchObject({ usedUsd: 0.5, limitUsd: 0.25 });

    // A store that answers the day but not a range.
    const withoutRange = {
      quotaToday: (actorRef: string, day: string) => store.quotaToday(actorRef, day),
    } as unknown as AgentStore;
    const dayOnly = await new LedgerQuotaProvider(withoutRange).report({ actor: { id: 'u1' } });
    expect(dayOnly.windows.map((window) => window.period)).toEqual(['day']);
  });
});
