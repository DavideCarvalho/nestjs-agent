import { AiModule, type AiModuleOptions, type AiUsageEvent } from '@nestjs/ai';
import { FakeModel, providerError } from '@nestjs/ai/testing';
import { Injectable } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AgentModule } from '../agent.module.js';
import { AiTool } from '../decorator/ai-tool.decorator.js';

@AiTool({ description: 'Weather for a city', input: z.object({ city: z.string() }) })
@Injectable()
class GetWeatherTool {
  async execute(input: { city: string }) {
    return { city: input.city, tempC: 21 };
  }
}

let app: NestExpressApplication | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

/** The answer's text, put back together from the stream's `text` frames. */
function textOf(res: { text: string }): string {
  return res.text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)) as { kind?: string; text?: string })
    .filter((frame) => frame.kind === 'text')
    .map((frame) => frame.text)
    .join('');
}

/** Fast retries: the backoff is `@nestjs/ai`'s, and its 1s default would slow every test down. */
const FAST = { retry: { backoff: { delay: 1, maxDelay: 5 } } } as const;

async function boot(ai: AiModuleOptions | undefined) {
  const moduleRef = await Test.createTestingModule({
    imports: [...(ai !== undefined ? [AiModule.forRoot(ai)] : []), AgentModule.forRoot({})],
    providers: [GetWeatherTool],
  }).compile();
  const testApp = moduleRef.createNestApplication<NestExpressApplication>();
  await testApp.init();
  app = testApp;
  return testApp.getHttpServer();
}

describe('AgentModule on @nestjs/ai models (no `model` configured)', () => {
  it("runs the turn on AiModule's default model and reports its usage through onUsage", async () => {
    const model = new FakeModel(['Hello from Nest AI.'], { modelId: 'fake-1' });
    const usage: AiUsageEvent[] = [];
    const server = await boot({
      models: { default: model },
      defaults: FAST,
      onUsage: (event) => {
        usage.push(event);
      },
    });

    const res = await request(server).post('/agent/chat').send({ message: 'hi' });

    expect(res.status).toBe(201);
    expect(textOf(res)).toContain('Hello from Nest AI.');
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]?.lastUserMessage).toBe('hi');
    expect(usage).toEqual([
      expect.objectContaining({
        label: 'agent',
        model: expect.objectContaining({ name: 'default', modelId: 'fake-1' }),
        attempt: 1,
        fallback: false,
        stream: true,
      }),
    ]);
  });

  it("offers the agent's tools and lets the agent loop run them", async () => {
    const model = new FakeModel([
      { toolCalls: [{ name: 'getWeather', input: { city: 'Recife' } }] },
      (call) => `It is ${JSON.stringify(call.toolResults[0]?.output)}`,
    ]);
    const server = await boot({ models: { default: model }, defaults: FAST });

    const res = await request(server).post('/agent/chat').send({ message: 'weather?' });

    expect(res.status).toBe(201);
    expect(model.calls[0]?.tools).toEqual(['getWeather']);
    expect(model.calls).toHaveLength(2);
    expect(textOf(res)).toContain('Recife');
  });

  it("retries a retryable provider failure under the model's retry policy", async () => {
    const model = new FakeModel([providerError(503), 'Recovered.']);
    const usage: AiUsageEvent[] = [];
    const server = await boot({
      models: { default: model },
      defaults: FAST,
      onUsage: (event) => {
        usage.push(event);
      },
    });

    const res = await request(server).post('/agent/chat').send({ message: 'hi' });

    expect(textOf(res)).toContain('Recovered.');
    expect(model.calls).toHaveLength(2);
    expect(usage[0]).toMatchObject({ attempt: 2, fallback: false });
  });

  it("falls back to the model's `fallback` when it fails for good", async () => {
    const primary = new FakeModel([providerError(401)], { modelId: 'primary' });
    const backup = new FakeModel(['From the backup.'], { modelId: 'backup' });
    const usage: AiUsageEvent[] = [];
    const server = await boot({
      models: { default: { model: primary, fallback: 'backup' }, backup },
      defaults: FAST,
      onUsage: (event) => {
        usage.push(event);
      },
    });

    const res = await request(server).post('/agent/chat').send({ message: 'hi' });

    expect(textOf(res)).toContain('From the backup.');
    expect(primary.calls).toHaveLength(1);
    expect(usage[0]).toMatchObject({ fallback: true, model: { name: 'backup' } });
  });

  it('never retries once text has reached the reader', async () => {
    const model = new FakeModel([
      { text: 'Partial answer', streamError: providerError(503) },
      'Should never be asked.',
    ]);
    const server = await boot({ models: { default: model }, defaults: FAST });

    const res = await request(server).post('/agent/chat').send({ message: 'hi' });

    expect(model.calls).toHaveLength(1);
    expect(textOf(res)).not.toContain('Should never be asked.');
  });

  it("lists AiModule's models in the picker, and runs a turn on the one picked", async () => {
    const fast = new FakeModel(['fast answer']);
    const smart = new FakeModel(['smart answer']);
    const server = await boot({ models: { default: fast, smart }, defaults: FAST });

    const listed = await request(server).get('/agent/models');
    expect(listed.status).toBe(200);
    expect(listed.body.default).toBe('default');
    const ids = (listed.body.providers as Array<{ models: Array<{ id: string }> }>).flatMap(
      (group) => group.models.map((entry) => entry.id),
    );
    expect(ids.sort()).toEqual(['default', 'smart']);

    const res = await request(server).post('/agent/chat').send({ message: 'hi', model: 'smart' });
    expect(textOf(res)).toContain('smart answer');
    expect(fast.calls).toHaveLength(0);
  });

  it("sends the model's generation settings as @nestjs/ai's own calls do, the model's over `defaults`", async () => {
    const model = new FakeModel(['Tuned.']);
    // `@nestjs/ai`'s call plan forwards these off a model definition and `defaults` too, beyond the
    // four its `AiCallSettings` type names.
    const tuned = {
      model,
      temperature: 0.2,
      topP: 0.9,
      topK: 40,
      seed: 7,
      stopSequences: ['END'],
      presencePenalty: 0.1,
    };
    const server = await boot({
      models: { default: tuned },
      defaults: { ...FAST, maxOutputTokens: 256, frequencyPenalty: 0.3, temperature: 1 } as never,
    });

    await request(server).post('/agent/chat').send({ message: 'hi' });

    expect(model.calls[0]?.options).toMatchObject({
      temperature: 0.2,
      topP: 0.9,
      topK: 40,
      seed: 7,
      stopSequences: ['END'],
      presencePenalty: 0.1,
      frequencyPenalty: 0.3,
      maxOutputTokens: 256,
    });
  });

  it('refuses to boot with neither a `model` nor an AiModule', async () => {
    await expect(boot(undefined)).rejects.toThrow(/no AiModule was found/);
  });
});
