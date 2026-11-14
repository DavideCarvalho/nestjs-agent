import type { ToolCatalogEntry } from '@dudousxd/nestjs-agent-core';
import { AgentFunction, type AgentFunctionContext, AiExecutionContext, AiModule } from '@nestjs/ai';
import { FakeModel } from '@nestjs/ai/testing';
import { type CanActivate, type ExecutionContext, Injectable, UseGuards } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AgentModule } from '../agent.module.js';
import type { AgentModuleOptions } from '../agent.options.js';
import { AgentService } from '../agent.service.js';
import { HeaderActorResolver } from '../resolver/header-actor-resolver.js';
import { AgentFunction as GovernedAgentFunction } from './agent-function.decorator.js';

const seen: Array<{ type: string; user: unknown; city?: string }> = [];

/** A guard of the application's own: it sees the call as `'ai'`, and refuses Atlantis. */
@Injectable()
class NoAtlantisGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const call = AiExecutionContext.create(context);
    const input = call.getInput<{ city?: string }>();
    seen.push({
      type: context.getType(),
      user: call.getContext().user,
      ...(input.city !== undefined ? { city: input.city } : {}),
    });
    return input.city !== 'Atlantis';
  }
}

const CityInput = z.object({ city: z.string() });

@Injectable()
class WeatherFunctions {
  @AgentFunction({ name: 'weather', description: 'Weather for a city', inputSchema: CityInput })
  @UseGuards(NoAtlantisGuard)
  weather({ city }: { city: string }, ctx: AgentFunctionContext) {
    return { city, tempC: 21, toolCallId: ctx.toolCallId };
  }

  @GovernedAgentFunction({
    name: 'evacuate',
    description: 'Evacuate a city',
    inputSchema: CityInput,
    kind: 'action',
  })
  evacuate({ city }: { city: string }) {
    return { evacuated: city };
  }

  @GovernedAgentFunction({ name: 'launch', description: 'Launch the rockets', roles: ['ADMIN'] })
  launch() {
    return { launched: true };
  }
}

let app: NestExpressApplication | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  seen.length = 0;
});

function textOf(res: { text: string }): string {
  return res.text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)) as { kind?: string; text?: string })
    .filter((frame) => frame.kind === 'text')
    .map((frame) => frame.text)
    .join('');
}

async function collect(iterable: AsyncIterable<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let out = '';
  for await (const chunk of iterable) out += decoder.decode(chunk);
  return out;
}

async function boot(model: FakeModel, options: Partial<AgentModuleOptions> = {}) {
  const moduleRef = await Test.createTestingModule({
    imports: [
      AiModule.forRoot({ models: { default: model } }),
      AgentModule.forRoot({
        actorResolver: new HeaderActorResolver(),
        defaultRoles: ['USER'],
        ...options,
      }),
    ],
    providers: [WeatherFunctions, NoAtlantisGuard],
  }).compile();
  const testApp = moduleRef.createNestApplication<NestExpressApplication>();
  await testApp.init();
  app = testApp;
  return testApp.getHttpServer();
}

const asUser = { 'x-actor-id': 'u1', 'x-actor-role': 'USER' };

describe('@nestjs/ai agent functions as agent tools', () => {
  it('offers them governed: kind from the governance (read by default), roles gating who sees them', async () => {
    const server = await boot(new FakeModel([]));

    const user = await request(server).get('/agent/tools').set(asUser);
    expect(user.body.data as ToolCatalogEntry[]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'weather', kind: 'read' }),
        expect.objectContaining({ name: 'evacuate', kind: 'action' }),
      ]),
    );
    expect((user.body.data as ToolCatalogEntry[]).map((tool) => tool.name)).not.toContain('launch');

    const admin = await request(server)
      .get('/agent/tools')
      .set({ 'x-actor-id': 'a1', 'x-actor-role': 'ADMIN' });
    expect((admin.body.data as ToolCatalogEntry[]).map((tool) => tool.name)).toContain('launch');
  });

  it("runs a call through the method's guards, as the turn's actor", async () => {
    const model = new FakeModel([
      { toolCalls: [{ name: 'weather', input: { city: 'Recife' } }] },
      (call) => `Got ${JSON.stringify(call.toolResults[0]?.output)}`,
    ]);
    const server = await boot(model);

    const res = await request(server).post('/agent/chat').set(asUser).send({ message: 'weather?' });

    expect(res.status).toBe(201);
    expect(seen).toEqual([
      { type: 'ai', user: expect.objectContaining({ id: 'u1' }), city: 'Recife' },
    ]);
    expect(textOf(res)).toContain('tempC');
  });

  it("hands the model the guard's refusal as the tool's failure", async () => {
    const model = new FakeModel([
      { toolCalls: [{ name: 'weather', input: { city: 'Atlantis' } }] },
      (call) => `Result: ${JSON.stringify(call.toolResults[0]?.output)}`,
    ]);
    const server = await boot(model);

    const res = await request(server).post('/agent/chat').set(asUser).send({ message: 'weather?' });

    expect(seen).toHaveLength(1);
    expect(textOf(res)).toMatch(/Forbidden|error/i);
    expect(textOf(res)).not.toContain('tempC');
  });

  it('parks an `action` agent function until a person approves it, then runs it', async () => {
    const evacuated: string[] = [];
    const model = new FakeModel([
      { toolCalls: [{ name: 'evacuate', input: { city: 'Recife' } }] },
      (call) => {
        evacuated.push(JSON.stringify(call.toolResults[0]?.output));
        return 'Done.';
      },
    ]);
    await boot(model);
    const agent = (app as NestExpressApplication).get(AgentService);
    const actor = { id: 'u1', roles: ['USER'] };

    const { runId } = await agent.chat({ actor, message: 'go' });
    const collected = collect(agent.subscribe(runId));
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Parked: the model has asked once, and the function has not run.
    expect(model.calls).toHaveLength(1);
    expect(evacuated).toEqual([]);

    await agent.approve(actor, 'call-1');
    const streamed = await collected;

    expect(streamed).toContain('Done.');
    expect(evacuated[0]).toContain('Recife');
  });

  it('`agentFunctions: false` leaves them to @nestjs/ai', async () => {
    const server = await boot(new FakeModel([]), { agentFunctions: false });
    const res = await request(server).get('/agent/tools').set(asUser);
    expect((res.body.data as ToolCatalogEntry[]).map((tool) => tool.name)).not.toContain('weather');
  });
});
