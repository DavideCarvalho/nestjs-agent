import { AgentModule, AiTool } from '@dudousxd/nestjs-agent';
import { AGENT_TOOL_REGISTRY, type Actor, type ToolRegistry } from '@dudousxd/nestjs-agent-core';
import { FakeModelProvider, InMemoryAgentStore } from '@dudousxd/nestjs-agent-testing';
import {
  All,
  type CanActivate,
  Controller,
  type ExecutionContext,
  ForbiddenException,
  Get,
  type INestApplication,
  Injectable,
  type Provider,
  Res,
  type Type,
  UseGuards,
  createParamDecorator,
} from '@nestjs/common';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AgentMcpServerModule } from '../agent-mcp-server.module.js';
import type { AgentMcpServerModuleOptions } from '../agent-mcp-server.options.js';
import { BearerTokenActorResolver } from '../bearer-token-actor-resolver.js';
import { AGENT_MCP_ROUTE_TOOLS } from '../tokens.js';
import { Mcp } from './mcp.decorator.js';

const KEY = 'a-key-0123456789abcdef';
const ACTOR: Actor = { id: 'u-1', roles: ['ANALYST'] };

let app: INestApplication | undefined;

const Caller = createParamDecorator((_data: unknown, context: ExecutionContext): unknown => {
  const request: unknown = context.switchToHttp().getRequest();
  return Reflect.get(Object(request), 'user');
});

@Controller('raw')
class WritesItsOwnResponseController {
  @Get()
  @Mcp({ kind: 'read', description: 'Stream a file.' })
  download(@Res() _response: object): void {}
}

@Controller('any')
class AnswersEveryVerbController {
  @All()
  @Mcp({ kind: 'read', description: 'Answer anything.' })
  any(): string {
    return 'any';
  }
}

@Controller('reports')
class ReportsController {
  @Get()
  @Mcp({ kind: 'read', description: 'Read the audit log.', name: 'audit_log' })
  read(): string {
    return 'report';
  }
}

@AiTool({
  name: 'audit_log',
  kind: 'read',
  description: 'Read the audit log.',
  input: z.object({}),
})
@Injectable()
class AuditLogTool {
  execute(): Promise<string> {
    return Promise.resolve('the @AiTool');
  }
}

@Injectable()
class ServiceTokenGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request: unknown = context.switchToHttp().getRequest();
    const headers: unknown = Reflect.get(Object(request), 'headers');
    if (Reflect.get(Object(headers), 'x-service-token') === 'internal') {
      return true;
    }
    throw new ForbiddenException('no service token');
  }
}

@Controller('internal')
class InternalController {
  @Get()
  @UseGuards(ServiceTokenGuard)
  @Mcp({ kind: 'read', description: 'Read internal state.', roles: ['ANALYST'] })
  read(@Caller() caller: unknown): { caller: unknown } {
    return { caller };
  }
}

function moduleWith(input: {
  controllers: Array<Type<unknown>>;
  providers?: Provider[];
  routes?: AgentMcpServerModuleOptions['routes'];
}): TestingModuleBuilder {
  return Test.createTestingModule({
    imports: [
      AgentModule.forRoot({
        model: new FakeModelProvider(() => ({ text: 'ok' })),
        store: new InMemoryAgentStore(),
        actorResolver: new BearerTokenActorResolver([{ token: KEY, actor: ACTOR }]),
      }),
      AgentMcpServerModule.forRoot({
        name: 'spec-server',
        version: '1.0.0',
        auth: new BearerTokenActorResolver([{ token: KEY, actor: ACTOR }]),
        ...(input.routes !== undefined ? { routes: input.routes } : {}),
      }),
    ],
    controllers: input.controllers,
    ...(input.providers !== undefined ? { providers: input.providers } : {}),
  });
}

async function boot(input: Parameters<typeof moduleWith>[0]): Promise<INestApplication> {
  const created = (await moduleWith(input).compile()).createNestApplication();
  app = created;
  await created.init();
  return created;
}

/**
 * A boot whose only answer is whether it threw. `boot` resolves to the whole application, and an
 * assertion that prints one when it expected a rejection exhausts the heap rather than reporting.
 */
async function bootRefusal(input: Parameters<typeof moduleWith>[0]): Promise<void> {
  await boot(input);
}

afterEach(async () => {
  await app?.close().catch(() => undefined);
  app = undefined;
});

describe('what @Mcp() refuses to boot', () => {
  it('refuses a route that writes the HTTP response itself', async () => {
    // A tool call answers with the handler's return value, and a route holding @Res() returns
    // nothing — it would be exposed as a tool that always answers undefined.
    await expect(bootRefusal({ controllers: [WritesItsOwnResponseController] })).rejects.toThrow(
      /@Mcp\(\) on WritesItsOwnResponseController\.download: it declares @Res\(\)/,
    );
  });

  it('refuses a route with no single verb a dispatched request could carry', async () => {
    await expect(bootRefusal({ controllers: [AnswersEveryVerbController] })).rejects.toThrow(
      /AnswersEveryVerbController\.any: it is not an HTTP route with one verb/,
    );
  });

  it('refuses a name an @AiTool already answers for, naming both', async () => {
    await expect(
      bootRefusal({ controllers: [ReportsController], providers: [AuditLogTool] }),
    ).rejects.toThrow(/the @AiTool of that name and the route ReportsController\.read/);
  });
});

describe('the registry @Mcp() routes land in', () => {
  it('is its own, so mounting an MCP server does not change what the agent loop offers', async () => {
    const context = await boot({
      controllers: [InternalController],
      providers: [ServiceTokenGuard],
    });
    const agentTools = context.get<ToolRegistry>(AGENT_TOOL_REGISTRY);
    const routeTools = context.get<ToolRegistry>(AGENT_MCP_ROUTE_TOOLS);
    expect(routeTools.has('internal_read')).toBe(true);
    expect(agentTools.has('internal_read')).toBe(false);
  });
});

describe('the principal a dispatched call presents', () => {
  it('is the resolved actor on request.user by default, which a param decorator reads', async () => {
    const context = await boot({
      controllers: [InternalController],
      providers: [ServiceTokenGuard],
      routes: {
        principal: ({ actor }) => ({ user: actor, headers: { 'x-service-token': 'internal' } }),
      },
    });
    const routeTools = context.get<ToolRegistry>(AGENT_MCP_ROUTE_TOOLS);
    const result = await routeTools.invoke(
      'internal_read',
      {},
      { actor: ACTOR, threadId: 't', runId: 'r', requestId: 'q' },
      { can: () => true },
    );
    expect(result).toEqual({ caller: ACTOR });
  });

  it('carries nothing the deployment did not put there, so a guard wanting a header refuses', async () => {
    const context = await boot({
      controllers: [InternalController],
      providers: [ServiceTokenGuard],
    });
    const routeTools = context.get<ToolRegistry>(AGENT_MCP_ROUTE_TOOLS);
    await expect(
      routeTools.invoke(
        'internal_read',
        {},
        { actor: ACTOR, threadId: 't', runId: 'r', requestId: 'q' },
        { can: () => true },
      ),
    ).rejects.toThrow(/no service token \(HTTP 403\)/);
  });
});
