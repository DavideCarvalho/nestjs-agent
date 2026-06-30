import {
  FakeModelProvider,
  type FakeScript,
  InMemoryAgentStore,
} from '@dudousxd/nestjs-agent-testing';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { z } from 'zod';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentModule } from './agent.module.js';
import { AgentService } from './agent.service.js';
import { AiTool } from './decorator/ai-tool.decorator.js';

@AiTool({ name: 'getWeather', kind: 'read', description: 'weather', input: z.object({ city: z.string() }) })
@Injectable()
class GetWeatherTool {
  async execute(input: { city: string }) {
    return { tempC: 21, city: input.city };
  }
}

@AiTool({ name: 'purgeCache', kind: 'action', description: 'purge', input: z.object({ key: z.string() }) })
@Injectable()
class PurgeCacheTool {
  async execute(input: { key: string }) {
    return { purged: input.key };
  }
}

async function buildApp(script: FakeScript) {
  const store = new InMemoryAgentStore();
  const moduleRef = await Test.createTestingModule({
    imports: [
      AgentModule.forRoot({
        model: new FakeModelProvider(script),
        store,
        modelId: 'fake-1',
        systemPrompt: 'test agent',
      }),
    ],
    providers: [GetWeatherTool, PurgeCacheTool],
  }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>();
  await app.init();
  return { app, store, service: app.get(AgentService) };
}

async function collect(iterable: AsyncIterable<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let out = '';
  for await (const chunk of iterable) {
    out += decoder.decode(chunk);
  }
  return out;
}

describe('AgentModule (inline)', () => {
  let app: NestExpressApplication | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('streams a no-tool turn over SSE', async () => {
    const built = await buildApp(() => ({ text: 'hello over http' }));
    app = built.app;
    const res = await request(app.getHttpServer()).post('/agent/chat').send({ message: 'hi' });
    expect(res.status).toBe(201);
    expect(res.text).toContain('hello over http');
    expect(res.text).toContain('event: done');
  });

  it('auto-executes a read tool then answers', async () => {
    const script: FakeScript = (_args, turnIndex) =>
      turnIndex === 0
        ? { text: 'checking', toolCall: { name: 'getWeather', input: { city: 'Recife' } } }
        : { text: 'it is 21C' };
    const built = await buildApp(script);
    app = built.app;
    const { runId } = await built.service.chat({ actor: { id: 'u1', role: 'ADMIN' }, message: 'weather?' });
    const streamed = await collect(built.service.subscribe(runId));
    expect(streamed).toContain('it is 21C');
    expect(built.store.toolCallRows()[0]).toMatchObject({ toolName: 'getWeather', status: 'executed' });
  });

  it('suspends an action tool until approved, then executes', async () => {
    const script: FakeScript = (_args, turnIndex) =>
      turnIndex === 0
        ? { text: 'about to purge', toolCall: { name: 'purgeCache', input: { key: 'cfg' } } }
        : { text: 'purged ok' };
    const built = await buildApp(script);
    app = built.app;
    const { runId } = await built.service.chat({ actor: { id: 'u1', role: 'ADMIN' }, message: 'purge it' });

    const collected = collect(built.service.subscribe(runId));
    // give the loop a tick to reach the approval gate, then approve the (deterministic) tool id
    await new Promise((resolve) => setTimeout(resolve, 20));
    await built.service.approve(runId, 'call-0-purgeCache');

    const streamed = await collected;
    expect(streamed).toContain('purged ok');
    expect(built.store.toolCallRows()[0]).toMatchObject({ toolName: 'purgeCache', status: 'executed' });
  });
});
