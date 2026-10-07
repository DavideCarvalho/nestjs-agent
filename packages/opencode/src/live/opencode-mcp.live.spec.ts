import 'reflect-metadata';
import { AgentModule, AgentService, AiTool, HeaderActorResolver } from '@dudousxd/nestjs-agent';
import type {
  Actor,
  AiToolCtx,
  MemoryProvider,
  StoreMemoryInput,
} from '@dudousxd/nestjs-agent-core';
import { InMemoryAgentStore } from '@dudousxd/nestjs-agent-testing';
import { type INestApplication, Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { OpenCodeClient } from '../client.js';
import { openCode } from '../engine.js';
import type { OpenCodeHost, OpenCodeServer } from '../host.js';
import { frames, framesUntil } from '../testing/harness.js';
import { realClient } from './client-shape.js';

/**
 * The module's tools reaching a real OpenCode 2 session over the engine's own MCP endpoint
 * (`<agent path>/opencode/mcp`) — skipped unless a server is configured (see
 * `opencode.live.spec.ts`). The app listens on a local port; OpenCode calls the endpoint with the
 * bearer token the engine minted for the session and names its session in each call's `_meta`,
 * which ties the call to the turn: a component the tool pushes lands in the turn's stream and
 * message, `remember` writes at the actor's scope, and an action runs once per approval.
 */
const url = process.env.OPENCODE_LIVE_URL;
const live = describe.skipIf(url === undefined);
const TIMEOUT = 180_000;
const actor: Actor = { id: 'u1', roles: ['ADMIN'] };
const notes: unknown[] = [];

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

@AiTool({
  name: 'record_note',
  kind: 'action',
  description: 'Record a note for the user. Needs their approval.',
  input: z.object({ text: z.string() }),
  roles: [],
})
@Injectable()
class RecordNoteTool {
  async execute(input: { text: string }) {
    notes.push(input);
    return { recorded: true };
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

async function boot(store: InMemoryAgentStore, memory?: MemoryProvider) {
  const endpoint = { url: '' };
  const moduleRef = await Test.createTestingModule({
    imports: [
      AgentModule.forRoot({
        engine: openCode({
          host: new LiveHost(),
          tools: {
            get url() {
              return endpoint.url;
            },
            secret: 'live-secret',
          },
        }),
        store,
        ...(memory !== undefined ? { memory: { provider: memory } } : {}),
        actorResolver: new HeaderActorResolver(),
      }),
    ],
    providers: [ShowChartTool, RecordNoteTool],
  }).compile();
  const app = moduleRef.createNestApplication();
  await app.listen(0, '127.0.0.1');
  endpoint.url = `${await app.getUrl()}/agent/opencode/mcp`.replace('[::1]', '127.0.0.1');
  return app;
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
      const store = new InMemoryAgentStore();
      app = await boot(store, memory);

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

  it(
    'runs an action tool once the person approved it',
    async () => {
      notes.length = 0;
      const store = new InMemoryAgentStore();
      app = await boot(store);
      const service = app.get(AgentService);
      const { runId } = await service.chat({
        actor,
        message:
          'Call the record_note tool once with text "buy milk". Then reply with the single word: done.',
      });
      const asked = await framesUntil(service, runId, (f) => f.kind === 'approval-requested');
      const request = asked.find((f) => f.kind === 'approval-requested');
      expect(notes).toEqual([]);
      if (request?.kind !== 'approval-requested') throw new Error('no approval was requested');
      await service.approve(actor, request.id);
      await frames(service, runId);
      expect(notes).toEqual([{ text: 'buy milk' }]);
    },
    TIMEOUT,
  );
});
