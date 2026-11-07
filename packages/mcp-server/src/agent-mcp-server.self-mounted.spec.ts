import { AgentModule, AiTool } from '@dudousxd/nestjs-agent';
import { FakeModelProvider, InMemoryAgentStore } from '@dudousxd/nestjs-agent-testing';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { AuthorizationGuard, AuthorizationModule, Can, Policy } from '@nestjs/authorization';
import {
  All,
  Controller,
  type ExecutionContext,
  type INestApplication,
  Injectable,
  Module,
  Req,
  Res,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { McpHttpService } from '@nestjs/mcp';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AgentMcpAuthGuard, mcpActorOf } from './agent-mcp-auth.guard.js';
import { AgentMcpServerModule } from './agent-mcp-server.module.js';
import { BearerTokenActorResolver } from './bearer-token-actor-resolver.js';
import { McpChallengeFilter } from './mcp-challenge.js';

const ANALYST = 'analyst-key-0123456789';
const VIEWER = 'viewer-key-9876543210';

@AiTool({
  name: 'search_docs',
  kind: 'read',
  description: 'Search the handbook.',
  input: z.object({ q: z.string() }),
})
@Injectable()
class SearchDocsTool {
  execute(input: { q: string }) {
    return Promise.resolve(`found ${input.q}`);
  }
}

@Policy()
class McpPolicy {
  connect(user: { roles?: string[] } | null) {
    return user?.roles?.includes('ANALYST') === true;
  }
}

/**
 * The endpoint served from the app's own controller: `@nestjs/mcp`'s `McpHttpService` behind the
 * agent's guard and challenge filter — protected with the official `@Can()`, as any route of the app.
 * The official guard runs after the agent's (`globalGuard: false`, as `@nestjs/authorization` says
 * to do "after your authentication guard"), so it sees the actor the agent's guard resolved.
 */
@Controller('ops/mcp')
@UseGuards(AgentMcpAuthGuard, AuthorizationGuard)
@UseFilters(McpChallengeFilter)
@Can(McpPolicy, 'connect')
class OwnMcpController {
  constructor(private readonly mcp: McpHttpService) {}

  @All()
  serve(@Req() req: unknown, @Res() res: unknown) {
    return this.mcp.serve(req, res);
  }
}

const resolver = new BearerTokenActorResolver([
  { token: ANALYST, actor: { id: 'u-analyst', roles: ['ANALYST'] } },
  { token: VIEWER, actor: { id: 'u-viewer', roles: ['VIEWER'] } },
]);

@Module({
  imports: [
    AgentMcpServerModule.forRoot({ name: 'spec', version: '1.0.0', auth: resolver, path: false }),
  ],
  controllers: [OwnMcpController],
})
class OwnMcpModule {}

let app: INestApplication | undefined;
const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await app?.close();
  app = undefined;
});

async function boot(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      AgentModule.forRoot({
        model: new FakeModelProvider(() => ({ text: 'ok' })),
        store: new InMemoryAgentStore(),
        actorResolver: resolver,
      }),
      AuthorizationModule.forRoot({
        globalGuard: false,
        policies: [McpPolicy],
        // The official guard's user is the actor the agent's guard resolved (it runs before).
        getUser: (context: ExecutionContext) =>
          mcpActorOf(context.switchToHttp().getRequest()) ?? null,
      }),
      OwnMcpModule,
    ],
    providers: [SearchDocsTool],
  }).compile();
  const created = moduleRef.createNestApplication();
  await created.listen(0, '127.0.0.1');
  app = created;
  return created;
}

function url(context: INestApplication, path: string): string {
  const address = context.getHttpServer().address() as { port: number };
  return `http://127.0.0.1:${address.port}${path}`;
}

describe('AgentMcpServerModule({ path: false }) — the endpoint on a controller of the app’s own', () => {
  it('mounts nothing of its own', async () => {
    const context = await boot();
    await request(context.getHttpServer())
      .post('/mcp')
      .set('authorization', `Bearer ${ANALYST}`)
      .expect(404);
  });

  it('serves the agent’s tools there, behind the app’s own @Can()', async () => {
    const context = await boot();
    const transport = new StreamableHTTPClientTransport(new URL(url(context, '/ops/mcp')), {
      requestInit: { headers: { authorization: `Bearer ${ANALYST}` } },
    });
    const client = new Client({ name: 'spec', version: '1.0.0' });
    await client.connect(transport);
    clients.push(client);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(['search_docs']);
    const result = await client.callTool({ name: 'search_docs', arguments: { q: 'leave' } });
    expect(result.content).toEqual([{ type: 'text', text: 'found leave' }]);
  });

  it('answers 401 without a credential and 403 when the policy refuses', async () => {
    const context = await boot();
    const server = context.getHttpServer();
    const initialize = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'p', version: '1' },
      },
    };
    await request(server).post('/ops/mcp').send(initialize).expect(401);
    await request(server)
      .post('/ops/mcp')
      .set('authorization', `Bearer ${VIEWER}`)
      .send(initialize)
      .expect(403);
  });
});
