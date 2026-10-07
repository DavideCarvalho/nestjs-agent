import 'reflect-metadata';
import { AgentModule, AgentService, AiTool, HeaderActorResolver } from '@dudousxd/nestjs-agent';
import type {
  Actor,
  AiToolCtx,
  MemoryProvider,
  StoreMemoryInput,
} from '@dudousxd/nestjs-agent-core';
import { AgentMcpServerModule, BearerTokenActorResolver } from '@dudousxd/nestjs-agent-mcp-server';
import { InMemoryAgentStore } from '@dudousxd/nestjs-agent-testing';
import { type INestApplication, Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { OpenCodeClient } from '../client.js';
import { openCode } from '../engine.js';
import type { OpenCodeHost, OpenCodeServer } from '../host.js';
import { frames } from '../testing/harness.js';
import { OpenCodeTurns } from '../turns.js';
import { realClient } from './client-shape.js';

/**
 * The module's tools reaching a real OpenCode 2 session over MCP — skipped unless a server is
 * configured (see `opencode.live.spec.ts`). The app listens on a local port; OpenCode calls its MCP
 * endpoint with a bearer token and names its session in each call's `_meta`, which ties the call
 * to the turn: a component the tool pushes lands in the turn's stream and message, and `remember`
 * writes at the actor's scope.
 */
const url = process.env.OPENCODE_LIVE_URL;
const live = describe.skipIf(url === undefined);
const TIMEOUT = 180_000;
const actor: Actor = { id: 'u1', roles: ['ADMIN'] };
const TOKEN = 'live-mcp-token';

@AiTool({
  name: 'show_chart',
  kind: 'read',
  description: 'Show the user a chart of their weekly numbers.',
  input: z.object({}),
  roles: [],
})
@Injectable()
class ShowChartTool {
  async execute(_input: unknown, ctx: AiToolCtx) {
    await ctx.emitUi('Chart', { series: [3, 5, 8] }, { id: 'weekly-chart' });
    return { shown: true, thread: ctx.threadId };
  }
}

class LiveHost implements OpenCodeHost {
  readonly client: OpenCodeClient = realClient(url ?? '', process.env.OPENCODE_LIVE_PASSWORD ?? '');

  async server(): Promise<OpenCodeServer> {
    return { client: this.client, key: 'live-mcp', bootId: 'live' };
  }

  async session() {
    const [providerID, ...rest] = (process.env.OPENCODE_LIVE_MODEL ?? '').split('/');
    return {
      model: { providerID: providerID ?? '', id: rest.join('/') },
      location: { directory: process.env.OPENCODE_LIVE_DIR ?? process.cwd() },
      // Code mode reaches MCP tools through `execute`; the engine adds the rules for its own tools.
      permissions: [
        { action: '*', resource: '*', effect: 'deny' as const },
        { action: 'execute', resource: '*', effect: 'allow' as const },
      ],
    };
  }
}

live('openCode tools over MCP against a real OpenCode 2 server', () => {
  let app: INestApplication | undefined;
  afterEach(async () => {
    // OpenCode keeps its MCP stream open; drop it so the server can close.
    (
      app?.getHttpServer() as { closeAllConnections?: () => void } | undefined
    )?.closeAllConnections?.();
    await app?.close();
    app = undefined;
  }, 30_000);

  it(
    "pushes a tool's component into the turn and remembers a fact",
    async () => {
      const written: StoreMemoryInput[] = [];
      const memory: MemoryProvider = {
        list: () => [],
        forget: () => false,
        write: (input) => {
          written.push(input);
          return { id: `m${written.length}`, ...input, updatedAt: new Date().toISOString() };
        },
      };
      const endpoint = { url: '' };
      const liveHost = new LiveHost();
      const store = new InMemoryAgentStore();
      const moduleRef = await Test.createTestingModule({
        imports: [
          AgentModule.forRoot({
            engine: openCode({
              host: liveHost,
              tools: {
                get url() {
                  return endpoint.url;
                },
                headers: () => ({ Authorization: `Bearer ${TOKEN}` }),
              },
            }),
            store,
            memory: { provider: memory },
            actorResolver: new HeaderActorResolver(),
          }),
          AgentMcpServerModule.forRootAsync({
            inject: [OpenCodeTurns],
            useFactory: (turns: OpenCodeTurns) => ({
              name: 'live',
              version: '1.0.0',
              auth: new BearerTokenActorResolver([{ token: TOKEN, actor }]),
              // OpenCode's `ask` rules put a person in front of action tools; the MCP surface runs them.
              actions: 'execute',
              context: (input) => turns.toolContext(input),
            }),
          }),
        ],
        providers: [ShowChartTool],
      }).compile();
      app = moduleRef.createNestApplication();
      await app.listen(0, '127.0.0.1');
      endpoint.url = `${await app.getUrl()}/mcp`.replace('[::1]', '127.0.0.1');

      const service = app.get(AgentService);
      const { runId, threadId } = await service.chat({
        actor,
        message:
          'First call the show_chart tool. Then call the remember tool with key "favorite-color" and fact "The user likes blue". Then reply with the single word: done.',
      });
      const fs = await frames(service, runId);

      expect(fs).toContainEqual({
        kind: 'ui',
        id: 'weekly-chart',
        component: 'Chart',
        props: { series: [3, 5, 8] },
      });
      const messages = (await store.getThread(threadId))?.messages ?? [];
      expect(messages.flatMap((m) => m.ui ?? []).map((c) => c.id)).toContain('weekly-chart');
      expect(written).toEqual([
        expect.objectContaining({
          key: 'favorite-color',
          scope: 'actor:u1',
          origin: expect.objectContaining({ author: 'agent', threadId, runId }),
        }),
      ]);
    },
    TIMEOUT,
  );
});
