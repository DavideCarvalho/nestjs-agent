import {
  type Actor,
  DefaultRolesPolicy,
  type RolesPolicy,
  type ToolHandler,
  ToolRegistry,
  type ToolSpec,
} from '@dudousxd/nestjs-agent-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { type CreateAgentMcpServerOptions, createAgentMcpServer } from './agent-mcp-server.js';

const ANALYST: Actor = { id: 'u-analyst', roles: ['ANALYST'] };

const searchInput = z.object({ q: z.string() });
const purgeInput = z.object({ key: z.string() });

/** Every tool's handler, so a spec can assert that a refused call never reached one. */
interface Handlers {
  search: ReturnType<typeof vi.fn>;
  purge: ReturnType<typeof vi.fn>;
  delegate: ReturnType<typeof vi.fn>;
  retired: ReturnType<typeof vi.fn>;
}

function toolsFor(handlers: Handlers): Array<{ spec: ToolSpec; handler: ToolHandler }> {
  return [
    {
      spec: {
        name: 'search_docs',
        kind: 'read',
        description: 'Search the handbook.',
        inputSchema: searchInput,
        roles: ['ANALYST'],
      },
      handler: {
        execute: async (input) => {
          handlers.search(input);
          return `found ${searchInput.parse(input).q}`;
        },
      },
    },
    {
      spec: {
        name: 'purge_cache',
        kind: 'action',
        description: 'Drop a cache key.',
        inputSchema: purgeInput,
        roles: ['ANALYST'],
      },
      handler: {
        execute: async (input) => {
          handlers.purge(input);
          return { purged: purgeInput.parse(input).key };
        },
      },
    },
    {
      spec: {
        name: 'delegate_to_billing',
        kind: 'agent',
        targetAgent: 'billing',
        description: 'Delegate a task to the billing agent.',
        inputSchema: z.object({ task: z.string() }),
        roles: ['ANALYST'],
      },
      // What `AiToolDiscoveryService` registers for a handoff edge: a stub, because the LOOP runs
      // the delegation. Reaching it through the registry answers nothing and delegates to nobody.
      handler: { execute: async () => handlers.delegate() ?? {} },
    },
    {
      spec: {
        name: 'retired_report',
        kind: 'read',
        description: 'A tool this deployment turned off.',
        inputSchema: z.object({}),
        roles: ['ANALYST'],
        enabled: false,
      },
      handler: { execute: async () => handlers.retired() },
    },
    {
      spec: {
        name: 'admin_audit',
        kind: 'read',
        description: 'Read the audit log.',
        inputSchema: z.object({}),
        roles: ['ADMIN'],
      },
      handler: { execute: async () => 'audit' },
    },
  ];
}

function freshHandlers(): Handlers {
  return { search: vi.fn(), purge: vi.fn(), delegate: vi.fn(), retired: vi.fn() };
}

/** An MCP client talking to `server`, sending `actor` as the transport's verified identity. */
async function connect(input: { server: Server; actor?: Actor }): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const { actor } = input;
  if (actor !== undefined) {
    const send = clientTransport.send.bind(clientTransport);
    clientTransport.send = (message, options) =>
      send(message, {
        ...options,
        authInfo: { token: '', clientId: actor.id, scopes: [], extra: { actor } },
      });
  }
  const client = new Client({ name: 'spec-client', version: '1.0.0' });
  await Promise.all([input.server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((part: unknown) =>
      typeof part === 'object' && part !== null && 'text' in part ? String(part.text) : '',
    )
    .join('');
}

describe('createAgentMcpServer', () => {
  let handlers: Handlers;
  let registry: ToolRegistry;

  beforeEach(() => {
    handlers = freshHandlers();
    registry = new ToolRegistry();
    for (const { spec, handler } of toolsFor(handlers)) {
      registry.register(spec, handler);
    }
  });

  function serverWith(options: Partial<CreateAgentMcpServerOptions> = {}): Server {
    return createAgentMcpServer({
      name: 'spec-server',
      version: '1.0.0',
      registry,
      policy: new DefaultRolesPolicy(),
      ...options,
    });
  }

  it('lists only the read tools this actor may use', async () => {
    const client = await connect({ server: serverWith(), actor: ANALYST });
    const { tools } = await client.listTools();
    // `purge_cache` is an action, `delegate_to_billing` is loop-served, `retired_report` is off,
    // and `admin_audit` belongs to a role this actor does not hold.
    expect(tools.map((tool) => tool.name)).toEqual(['search_docs']);
    expect(tools[0]?.annotations?.readOnlyHint).toBe(true);
    expect(tools[0]?.inputSchema.properties).toMatchObject({ q: { type: 'string' } });
  });

  it('runs a read tool and returns its output', async () => {
    const client = await connect({ server: serverWith(), actor: ANALYST });
    const result = await client.callTool({ name: 'search_docs', arguments: { q: 'leave policy' } });
    expect(result.isError).toBeFalsy();
    expect(textOf(result.content)).toBe('found leave policy');
  });

  it('serializes a non-string result', async () => {
    const client = await connect({ server: serverWith({ actions: 'execute' }), actor: ANALYST });
    const result = await client.callTool({ name: 'purge_cache', arguments: { key: 'k1' } });
    expect(textOf(result.content)).toBe('{"purged":"k1"}');
  });

  it('never runs an action tool for a caller with no human to approve it', async () => {
    const client = await connect({ server: serverWith(), actor: ANALYST });
    const result = await client.callTool({ name: 'purge_cache', arguments: { key: 'k1' } });
    expect(result.isError).toBe(true);
    expect(textOf(result.content)).toMatch(/approval/);
    expect(handlers.purge).not.toHaveBeenCalled();
  });

  it('runs an action tool only where the deployment opted in', async () => {
    const client = await connect({ server: serverWith({ actions: 'execute' }), actor: ANALYST });
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(['search_docs', 'purge_cache']);
    await client.callTool({ name: 'purge_cache', arguments: { key: 'k1' } });
    expect(handlers.purge).toHaveBeenCalledWith({ key: 'k1' });
  });

  it('never runs a loop-served tool, even under the action opt-in', async () => {
    const client = await connect({ server: serverWith({ actions: 'execute' }), actor: ANALYST });
    const result = await client.callTool({
      name: 'delegate_to_billing',
      arguments: { task: 'refund' },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result.content)).toMatch(/agent loop/);
    expect(handlers.delegate).not.toHaveBeenCalled();
  });

  it('refuses a tool left off the allow-list, not merely leaves it unadvertised', async () => {
    // `ToolRegistry.invoke` knows nothing about the allow-list — it is applied where the LIST is
    // built. A caller who guesses the name reaches the tool unless the call is gated too.
    const client = await connect({
      server: serverWith({ allowedTools: ['retired_report'] }),
      actor: ANALYST,
    });
    expect((await client.listTools()).tools).toEqual([]);
    const result = await client.callTool({ name: 'search_docs', arguments: { q: 'x' } });
    expect(result.isError).toBe(true);
    expect(textOf(result.content)).toMatch(/does not list it/);
    expect(handlers.search).not.toHaveBeenCalled();
  });

  it('refuses a tool this deployment has turned off', async () => {
    const client = await connect({ server: serverWith(), actor: ANALYST });
    const result = await client.callTool({ name: 'retired_report', arguments: {} });
    expect(result.isError).toBe(true);
    expect(handlers.retired).not.toHaveBeenCalled();
  });

  it('gates on the host policy that is passed in, not on a rule of its own', async () => {
    const asked: string[] = [];
    const policy: RolesPolicy = {
      can: (_actor, tool) => {
        asked.push(tool.name);
        return false;
      },
    };
    const client = await connect({ server: serverWith({ policy }), actor: ANALYST });
    expect((await client.listTools()).tools).toEqual([]);
    expect(asked).toContain('search_docs');
    const result = await client.callTool({ name: 'search_docs', arguments: { q: 'x' } });
    expect(result.isError).toBe(true);
    expect(handlers.search).not.toHaveBeenCalled();
  });

  it('re-checks the role on call, so a list taken before a demotion buys nothing', async () => {
    let allowed = true;
    const policy: RolesPolicy = { can: () => allowed };
    const client = await connect({ server: serverWith({ policy }), actor: ANALYST });
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain('search_docs');
    allowed = false;
    const result = await client.callTool({ name: 'search_docs', arguments: { q: 'x' } });
    expect(result.isError).toBe(true);
    expect(handlers.search).not.toHaveBeenCalled();
  });

  it('re-validates the input against the tool schema', async () => {
    const client = await connect({ server: serverWith(), actor: ANALYST });
    const result = await client.callTool({ name: 'search_docs', arguments: { q: 42 } });
    expect(result.isError).toBe(true);
    expect(handlers.search).not.toHaveBeenCalled();
  });

  it('answers a tool nobody registered without pretending it exists', async () => {
    const client = await connect({ server: serverWith(), actor: ANALYST });
    const result = await client.callTool({ name: 'no_such_tool', arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result.content)).toMatch(/not registered/);
  });

  it('refuses a transport that authenticated nobody, as a protocol error', async () => {
    // Not a tool result: a client has to be able to tell "you are not authenticated" from "the tool
    // said no". Nothing here invents an actor to run as.
    const client = await connect({ server: serverWith() });
    await expect(client.listTools()).rejects.toThrow(/unauthorized/);
    await expect(client.callTool({ name: 'search_docs', arguments: { q: 'x' } })).rejects.toThrow(
      /unauthorized/,
    );
    expect(handlers.search).not.toHaveBeenCalled();
  });
});
