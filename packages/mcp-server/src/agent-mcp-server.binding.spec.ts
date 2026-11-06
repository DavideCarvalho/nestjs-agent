import { AgentModule, AiTool } from '@dudousxd/nestjs-agent';
import type { Actor } from '@dudousxd/nestjs-agent-core';
import { FakeModelProvider, InMemoryAgentStore } from '@dudousxd/nestjs-agent-testing';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, type McpServer } from '@modelcontextprotocol/server';
import { type INestApplicationContext, Injectable } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import { Tool } from '@nestjs/mcp';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { findMcpServerFactory } from './agent-mcp-server.binding.js';
import { AgentMcpServerModule } from './agent-mcp-server.module.js';
import { BearerTokenActorResolver } from './bearer-token-actor-resolver.js';

@AiTool({
  name: 'search_docs',
  kind: 'read',
  description: 'Search the handbook.',
  input: z.object({ q: z.string() }),
  roles: ['ANALYST'],
})
@Injectable()
class SearchDocsTool {
  execute(input: { q: string }) {
    return Promise.resolve(`found ${input.q}`);
  }
}

@Injectable()
class PingTools {
  @Tool({ description: 'Ping', inputSchema: z.object({}) })
  ping() {
    return 'pong';
  }
}

let context: INestApplicationContext | undefined;

afterEach(async () => {
  await context?.close();
  context = undefined;
});

async function boot(stdio?: { actor: Actor }): Promise<INestApplicationContext> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      AgentModule.forRoot({
        model: new FakeModelProvider(() => ({ text: 'ok' })),
        store: new InMemoryAgentStore(),
      }),
      AgentMcpServerModule.forRoot({
        name: 'spec-server',
        version: '1.0.0',
        auth: new BearerTokenActorResolver([]),
        ...(stdio !== undefined ? { stdio } : {}),
      }),
    ],
    providers: [SearchDocsTool, PingTools],
  }).compile();
  context = await moduleRef.init();
  return context;
}

/** A stdio connection's server, as `@nestjs/mcp`'s `McpStdioServer` would get it from the factory. */
async function stdioTools(app: INestApplicationContext): Promise<string[]> {
  const factory = findMcpServerFactory(app.get(ModulesContainer));
  if (factory === undefined) throw new Error("@nestjs/mcp's McpServerFactory was not found");
  const server = (await factory.create({ transport: 'stdio' })) as McpServer;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'spec-client', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
  await client.close();
  return names;
}

describe("AgentMcpServerBinding on @nestjs/mcp's factory", () => {
  it("finds @nestjs/mcp's McpServerFactory — the one place this package reaches in", async () => {
    // If @nestjs/mcp renames or reshapes it, this fails before anything is served wrongly.
    const app = await boot();
    expect(findMcpServerFactory(app.get(ModulesContainer))).toBeDefined();
  });

  it('serves the agent’s tools over stdio as the configured actor, beside the app’s own', async () => {
    const app = await boot({ actor: { id: 'cli', roles: ['ANALYST'] } });
    expect(await stdioTools(app)).toEqual(['ping', 'search_docs']);
  });

  it('serves a stdio connection only the app’s own @Tool() methods when no actor is configured', async () => {
    const app = await boot();
    expect(await stdioTools(app)).toEqual(['ping']);
  });
});
