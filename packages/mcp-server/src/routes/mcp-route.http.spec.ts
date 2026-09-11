import type { Server as HttpServer } from 'node:http';
import { AgentModule, AiTool } from '@dudousxd/nestjs-agent';
import type { Actor } from '@dudousxd/nestjs-agent-core';
import { FakeModelProvider, InMemoryAgentStore } from '@dudousxd/nestjs-agent-testing';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import {
  Body,
  type CallHandler,
  type CanActivate,
  Controller,
  type ExecutionContext,
  ForbiddenException,
  Get,
  type INestApplication,
  Injectable,
  type NestInterceptor,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { map } from 'rxjs/operators';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AgentMcpServerModule } from '../agent-mcp-server.module.js';
import { BearerTokenActorResolver } from '../bearer-token-actor-resolver.js';
import type { McpActionPolicy } from '../exposed-tools.js';
import { Mcp } from './mcp.decorator.js';

const ANALYST_KEY = 'analyst-key-0123456789';
const OPS_KEY = 'ops-key-9876543210';
const VIEWER_KEY = 'viewer-key-1122334455';
const ANALYST: Actor = { id: 'u-analyst', roles: ['ANALYST'] };
const OPS: Actor = { id: 'u-ops', roles: ['ANALYST', 'OPS'] };
const VIEWER: Actor = { id: 'u-viewer', roles: ['VIEWER'] };

const cancelled = vi.fn();
const listed = vi.fn();

/** Reads the principal off the request, exactly as an app's own roles guard would. */
@Injectable()
class OpsOnlyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request: unknown = context.switchToHttp().getRequest();
    const user: unknown = Reflect.get(Object(request), 'user');
    const roles: unknown = Reflect.get(Object(user), 'roles');
    if (Array.isArray(roles) && roles.includes('OPS')) {
      return true;
    }
    throw new ForbiddenException('cancelling an order is for OPS');
  }
}

@Injectable()
class StampInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler) {
    return next.handle().pipe(map((value) => ({ value, stamped: true })));
  }
}

@Controller('orders')
class OrdersController {
  @Get(':id')
  @Mcp({ kind: 'read', description: 'Read one order by its id.', roles: ['ANALYST'] })
  findOne(@Param('id', ParseIntPipe) id: number): { id: number; type: string } {
    return { id, type: typeof id };
  }

  @Get()
  @UseInterceptors(StampInterceptor)
  @Mcp({ kind: 'read', description: 'List orders, optionally by status.', roles: ['ANALYST'] })
  list(@Query('status') status: string | undefined): { status: string | undefined } {
    listed(status);
    return { status };
  }

  @Post('search')
  @Mcp({ kind: 'read', description: 'Search orders by a term in the body.', roles: ['ANALYST'] })
  search(@Body('term') term: string): { term: string } {
    return { term };
  }

  @Post(':id/cancel')
  @UseGuards(OpsOnlyGuard)
  @Mcp({ kind: 'action', description: 'Cancel an order.', roles: ['ANALYST'] })
  cancel(@Param('id') id: string): { cancelled: string } {
    cancelled(id);
    return { cancelled: id };
  }
}

@AiTool({
  name: 'search_docs',
  kind: 'read',
  description: 'Search the handbook.',
  input: z.object({ q: z.string() }),
  roles: ['ANALYST'],
})
@Injectable()
class SearchDocsTool {
  execute(input: { q: string }): Promise<string> {
    return Promise.resolve(`found ${input.q}`);
  }
}

let app: INestApplication | undefined;
const clients: Client[] = [];

async function boot(
  overrides: { actions?: McpActionPolicy; allowedTools?: string[] } = {},
): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      AgentModule.forRoot({
        model: new FakeModelProvider(() => ({ text: 'ok' })),
        store: new InMemoryAgentStore(),
        actorResolver: new BearerTokenActorResolver([{ token: ANALYST_KEY, actor: ANALYST }]),
      }),
      AgentMcpServerModule.forRoot({
        name: 'spec-server',
        version: '1.0.0',
        auth: new BearerTokenActorResolver([
          { token: ANALYST_KEY, actor: ANALYST },
          { token: OPS_KEY, actor: OPS },
          { token: VIEWER_KEY, actor: VIEWER },
        ]),
        ...(overrides.actions !== undefined ? { actions: overrides.actions } : {}),
        ...(overrides.allowedTools !== undefined ? { allowedTools: overrides.allowedTools } : {}),
      }),
    ],
    controllers: [OrdersController],
    providers: [OpsOnlyGuard, StampInterceptor, SearchDocsTool],
  }).compile();
  const created = moduleRef.createNestApplication();
  await created.listen(0, '127.0.0.1');
  app = created;
  return created;
}

function baseUrl(context: INestApplication): string {
  const server: HttpServer = context.getHttpServer();
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the test server is not listening on a TCP port');
  }
  return `http://127.0.0.1:${address.port}/mcp`;
}

async function connect(input: {
  context: INestApplication;
  token: string;
}): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(baseUrl(input.context)), {
    requestInit: { headers: { authorization: `Bearer ${input.token}` } },
  });
  const client = new Client({ name: 'spec-client', version: '1.0.0' });
  await client.connect(transport as Transport);
  clients.push(client);
  return client;
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) {
    throw new Error('the tool result carried no content array');
  }
  const [first]: unknown[] = content;
  const text: unknown = Reflect.get(Object(first), 'text');
  return typeof text === 'string' ? text : '';
}

/** What a `tools/call` rejection actually was, so a spec can assert on the status it carried. */
async function refusalOf(call: Promise<unknown>): Promise<McpError> {
  try {
    await call;
  } catch (error) {
    if (error instanceof McpError) {
      return error;
    }
    throw error;
  }
  throw new Error('the call was expected to be refused, and was not');
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await app?.close();
  app = undefined;
  cancelled.mockReset();
  listed.mockReset();
});

describe('@Mcp() routes over MCP', () => {
  it('lists a route-derived tool beside the @AiTools, with the schema its own declarations imply', async () => {
    const context = await boot();
    const client = await connect({ context, token: ANALYST_KEY });
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'orders_find_one',
      'orders_list',
      'orders_search',
      'search_docs',
    ]);
    const findOne = tools.find((tool) => tool.name === 'orders_find_one');
    expect(findOne?.inputSchema).toEqual({
      type: 'object',
      properties: {
        params: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
          additionalProperties: false,
        },
      },
      required: ['params'],
      additionalProperties: false,
    });
    expect(findOne?.annotations).toEqual({ readOnlyHint: true });
  });

  it('runs the route through its own pipes, so a ParseIntPipe still parses', async () => {
    const context = await boot();
    const client = await connect({ context, token: ANALYST_KEY });
    const result = await client.callTool({
      name: 'orders_find_one',
      arguments: { params: { id: '42' } },
    });
    // `type: 'number'` is the ParseIntPipe's work: the slot carried the string a request carries.
    expect(JSON.parse(textOf(result.content))).toEqual({ id: 42, type: 'number' });
  });

  it('answers a value the route’s pipe rejects with the status the pipe chose', async () => {
    const context = await boot();
    const client = await connect({ context, token: ANALYST_KEY });
    const refusal = await refusalOf(
      client.callTool({ name: 'orders_find_one', arguments: { params: { id: 'not-a-number' } } }),
    );
    expect(refusal.code).toBe(ErrorCode.InvalidParams);
    expect(refusal.data).toEqual({ httpStatus: 400 });
  });

  it('runs the route’s interceptors', async () => {
    const context = await boot();
    const client = await connect({ context, token: ANALYST_KEY });
    const result = await client.callTool({
      name: 'orders_list',
      arguments: { query: { status: 'open' } },
    });
    expect(JSON.parse(textOf(result.content))).toEqual({
      value: { status: 'open' },
      stamped: true,
    });
    expect(listed).toHaveBeenCalledWith('open');
  });

  it('carries a body slot to the route’s @Body declaration', async () => {
    const context = await boot();
    const client = await connect({ context, token: ANALYST_KEY });
    const result = await client.callTool({
      name: 'orders_search',
      arguments: { body: { term: 'late' } },
    });
    expect(JSON.parse(textOf(result.content))).toEqual({ term: 'late' });
  });

  it('fails the call with the guard’s own status, and never reaches the handler', async () => {
    // The whole reason a route is safe to expose is the authorization its author wrote. An MCP
    // caller the guard refuses must be refused, with the guard's status — not answered 200 with an
    // error in the body, which reads to a model as "try different arguments".
    const context = await boot({ actions: 'execute' });
    const client = await connect({ context, token: ANALYST_KEY });
    const refusal = await refusalOf(
      client.callTool({ name: 'orders_cancel', arguments: { params: { id: '42' } } }),
    );
    expect(refusal.code).toBe(ErrorCode.InvalidRequest);
    expect(refusal.data).toEqual({ httpStatus: 403 });
    expect(refusal.message).toMatch(/cancelling an order is for OPS/);
    expect(cancelled).not.toHaveBeenCalled();
  });

  it('lets the same call through for an actor the guard accepts', async () => {
    const context = await boot({ actions: 'execute' });
    const client = await connect({ context, token: OPS_KEY });
    const result = await client.callTool({
      name: 'orders_cancel',
      arguments: { params: { id: '42' } },
    });
    expect(JSON.parse(textOf(result.content))).toEqual({ cancelled: '42' });
    expect(cancelled).toHaveBeenCalledWith('42');
  });

  it('neither lists nor runs an action route while actions are denied', async () => {
    const context = await boot();
    const client = await connect({ context, token: OPS_KEY });
    expect((await client.listTools()).tools.map((tool) => tool.name)).not.toContain(
      'orders_cancel',
    );
    const result = await client.callTool({
      name: 'orders_cancel',
      arguments: { params: { id: '42' } },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result.content)).toMatch(/approval/);
    expect(cancelled).not.toHaveBeenCalled();
  });

  it('keeps a route off the surface that the allow-list leaves off, on the call as well as the list', async () => {
    const context = await boot({ allowedTools: ['orders_find_one'] });
    const client = await connect({ context, token: ANALYST_KEY });
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(['orders_find_one']);
    const result = await client.callTool({
      name: 'orders_list',
      arguments: { query: { status: 'open' } },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result.content)).toMatch(/does not list it/);
    expect(listed).not.toHaveBeenCalled();
  });

  it('consults the roles policy for a route-derived tool, on the list and on the call', async () => {
    // The route declared `roles: ['ANALYST']`, and this caller is not one. The policy is the app's
    // own AGENT_ROLES_POLICY — the gate a turn goes through — asked about an ordinary ToolSpec.
    const context = await boot();
    const client = await connect({ context, token: VIEWER_KEY });
    expect((await client.listTools()).tools).toEqual([]);
    const result = await client.callTool({
      name: 'orders_list',
      arguments: { query: { status: 'open' } },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result.content)).toMatch(/not allowed for this role/);
    expect(listed).not.toHaveBeenCalled();
  });

  it('answers an unidentified caller 401 before any route is reached', async () => {
    const context = await boot();
    await expect(connect({ context, token: 'a-key-nobody-issued' })).rejects.toThrow(/401/);
    expect(listed).not.toHaveBeenCalled();
  });

  it('refuses a name no registry holds rather than dispatching something else', async () => {
    const context = await boot();
    const client = await connect({ context, token: ANALYST_KEY });
    const result = await client.callTool({ name: 'orders_destroy', arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result.content)).toMatch(/is not registered/);
  });
});
