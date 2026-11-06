import { AGENT_STORE, type AiToolCtx, type InMemoryAgentStore } from '@dudousxd/nestjs-agent-core';
import { AiExecutionContext, AiModule, AiService, AiTools } from '@nestjs/ai';
import { FakeModel } from '@nestjs/ai/testing';
import { type CanActivate, type ExecutionContext, Injectable, UseGuards } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AgentModule } from '../agent.module.js';
import { AgentService } from '../agent.service.js';
import { AiTool } from '../decorator/ai-tool.decorator.js';
import { HeaderActorResolver } from '../resolver/header-actor-resolver.js';

const guarded: string[] = [];
const contexts: AiToolCtx[] = [];

@Injectable()
class RecordingGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const call = AiExecutionContext.create(context);
    const city = call.getInput<{ city: string }>().city;
    guarded.push(`${context.getType()}:${city}`);
    return city !== 'Atlantis';
  }
}

/** A plain `@AiTool`: no `@nestjs/ai` decorator in sight, only a guard on the class. */
@AiTool({ description: 'Weather for a city', input: z.object({ city: z.string() }) })
@UseGuards(RecordingGuard)
@Injectable()
class GetWeatherTool {
  async execute(input: { city: string }, ctx: AiToolCtx) {
    contexts.push(ctx);
    // A Date: what `@nestjs/ai` would turn into a string, and the agent persists as it is.
    return { city: input.city, tempC: 21, at: new Date(0) };
  }
}

@AiTool({
  kind: 'action',
  description: 'Purge a cache key',
  input: z.object({ key: z.string() }),
})
@Injectable()
class PurgeCacheTool {
  async execute(input: { key: string }) {
    return { purged: input.key };
  }
}

let app: NestExpressApplication | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  guarded.length = 0;
  contexts.length = 0;
});

async function collect(iterable: AsyncIterable<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let out = '';
  for await (const chunk of iterable) out += decoder.decode(chunk);
  return out;
}

async function boot(model: FakeModel) {
  const moduleRef = await Test.createTestingModule({
    imports: [
      AiModule.forRoot({ models: { default: model } }),
      AgentModule.forRoot({ actorResolver: new HeaderActorResolver() }),
    ],
    providers: [GetWeatherTool, PurgeCacheTool, RecordingGuard],
  }).compile();
  const testApp = moduleRef.createNestApplication<NestExpressApplication>();
  await testApp.init();
  app = testApp;
  return testApp;
}

describe('@AiTool is a @nestjs/ai agent function too', () => {
  it('is one of AiModule’s agent functions', async () => {
    const testApp = await boot(new FakeModel([]));
    const names = [...testApp.get(AiTools).tools.keys()];
    expect(names).toEqual(expect.arrayContaining(['getWeather', 'purgeCache']));
  });

  it("runs an agent turn's call through its guards, with the turn's own AiToolCtx and raw output", async () => {
    const model = new FakeModel([
      { toolCalls: [{ name: 'getWeather', input: { city: 'Recife' } }] },
      'Done.',
    ]);
    const testApp = await boot(model);
    const agent = testApp.get(AgentService);
    const actor = { id: 'u1', roles: ['USER'] };

    const { runId } = await agent.chat({ actor, message: 'weather?' });
    const streamed = await collect(agent.subscribe(runId));

    expect(streamed).toContain('Done.');
    expect(guarded).toEqual(['ai:Recife']);
    expect(contexts[0]?.actor).toEqual(actor);
    expect(contexts[0]?.threadId).not.toBe('');
    expect(contexts[0]?.runId).toBe(runId);
    // What execute() returned, not @nestjs/ai's JSON of it: the Date is still a Date.
    const [row] = testApp.get<InMemoryAgentStore>(AGENT_STORE).toolCallRows();
    expect(row).toMatchObject({ toolName: 'getWeather', status: 'executed' });
    expect((row?.output as { at?: unknown } | undefined)?.at).toBeInstanceOf(Date);
  });

  it("fails the agent's call with the guard's refusal", async () => {
    const model = new FakeModel([
      { toolCalls: [{ name: 'getWeather', input: { city: 'Atlantis' } }] },
      (call) => `Result: ${JSON.stringify(call.toolResults[0]?.output)}`,
    ]);
    const testApp = await boot(model);
    const agent = testApp.get(AgentService);

    const { runId } = await agent.chat({ actor: { id: 'u1' }, message: 'weather?' });
    const streamed = await collect(agent.subscribe(runId));

    expect(guarded).toEqual(['ai:Atlantis']);
    expect(contexts).toHaveLength(0);
    expect(streamed).toMatch(/Forbidden/);
  });

  it("can be offered by @nestjs/ai's own calls, outside any agent turn", async () => {
    const model = new FakeModel([
      { toolCalls: [{ name: 'getWeather', input: { city: 'Olinda' } }] },
      (call) => `It is ${JSON.stringify(call.toolResults[0]?.output)}`,
    ]);
    const testApp = await boot(model);

    const { text } = await testApp.get(AiService).generateText({
      prompt: 'weather?',
      tools: ['getWeather'],
      caller: { user: { id: 'u2', roles: ['USER'] } },
    });

    expect(text).toContain('Olinda');
    expect(guarded).toEqual(['ai:Olinda']);
    expect(contexts[0]?.actor).toMatchObject({ id: 'u2', roles: ['USER'] });
  });

  it("refuses an `action` in @nestjs/ai's own calls: only an agent turn asks a person", async () => {
    const model = new FakeModel([
      { toolCalls: [{ name: 'purgeCache', input: { key: 'cfg' } }] },
      (call) => `Result: ${JSON.stringify(call.toolResults[0]?.output)}`,
    ]);
    const testApp = await boot(model);

    const { text } = await testApp.get(AiService).generateText({
      prompt: 'purge',
      tools: ['purgeCache'],
      caller: { user: { id: 'u2' } },
    });

    expect(text).toMatch(/runs only in an agent turn/);
    expect(text).not.toContain('purged');
  });
});
