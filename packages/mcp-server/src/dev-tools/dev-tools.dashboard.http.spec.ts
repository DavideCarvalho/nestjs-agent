import { AgentModule } from '@dudousxd/nestjs-agent';
import { AGENT_GOVERNANCE_QUERIES } from '@dudousxd/nestjs-agent-core';
import { AgentDashboardModule, authorizeByToken } from '@dudousxd/nestjs-agent-dashboard';
import { FakeModelProvider, InMemoryAgentStore } from '@dudousxd/nestjs-agent-testing';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Global, type INestApplication, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentMcpServerModule } from '../agent-mcp-server.module.js';
import { BearerTokenActorResolver } from '../bearer-token-actor-resolver.js';
import { DEV_TOOLS_SLOT } from './contract.js';

const CONSOLE_TOKEN = 'console-token-0123456789';

const RUN = {
  runId: 'r1',
  threadId: 't1',
  actorRef: 'user:1',
  agentName: 'support',
  status: 'failed',
  durationMs: 12,
  ttftMs: null,
  costUsd: null,
};

const runsPage = vi.fn(async (query: { page: number; pageSize: number }) => ({
  rows: [RUN],
  total: 1,
  page: query.page,
  pageSize: query.pageSize,
}));

/** The governance read-model a store module binds globally. */
@Global()
@Module({
  providers: [{ provide: AGENT_GOVERNANCE_QUERIES, useValue: { runsPage } }],
  exports: [AGENT_GOVERNANCE_QUERIES],
})
class GovernanceModule {}

let app: INestApplication | undefined;
const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await app?.close();
  app = undefined;
  delete (globalThis as Record<symbol, unknown>)[DEV_TOOLS_SLOT];
});

async function boot(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      GovernanceModule,
      AgentModule.forRoot({
        model: new FakeModelProvider(() => ({ text: 'ok' })),
        store: new InMemoryAgentStore(),
      }),
      AgentDashboardModule.forRoot({ authorize: authorizeByToken({ token: CONSOLE_TOKEN }) }),
      AgentMcpServerModule.forRoot({
        name: 'spec-server',
        version: '1.0.0',
        auth: new BearerTokenActorResolver([]),
      }),
    ],
  }).compile();
  const created = moduleRef.createNestApplication({ logger: false });
  await created.listen(0, '127.0.0.1');
  app = created;
  return created;
}

function devUrl(context: INestApplication): URL {
  const address = context.getHttpServer().address();
  if (address === null || typeof address === 'string') throw new Error('not listening');
  return new URL(`http://127.0.0.1:${address.port}/mcp/aviary`);
}

describe('dev MCP endpoint with the agent dashboard', () => {
  it('serves the governance reads to the console token, as the console API serves them', async () => {
    const context = await boot();
    const transport = new StreamableHTTPClientTransport(devUrl(context), {
      requestInit: { headers: { authorization: `Bearer ${CONSOLE_TOKEN}` } },
    });
    const client = new Client({ name: 'claude-code', version: '1.0.0' });
    await client.connect(transport);
    clients.push(client);

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toContain('agent_list_runs');
    expect(client.getInstructions()).toContain('Agent governance');

    const result = await client.callTool({ name: 'agent_list_runs', arguments: { limit: 5 } });
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? '';
    const api = await request(context.getHttpServer())
      .get('/ai-gateway/api/runs-page?limit=5')
      .set('authorization', `Bearer ${CONSOLE_TOKEN}`)
      .expect(200);
    expect(JSON.parse(text)).toEqual({ items: api.body.rows, next: null, total: 1 });
  });

  it('answers 401 without the console token, like the console', async () => {
    const context = await boot();
    const res = await request(context.getHttpServer())
      .post('/mcp/aviary')
      .set('accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    expect(res.status).toBe(401);
    await request(context.getHttpServer()).get('/ai-gateway/api/runs-page').expect(401);
  });
});
