// Personas: named variants of ONE agent — a prompt and, optionally, a narrower tool allow-list —
// picked per send, pinned on the thread, carried by a queued message, listed by `GET agents`, and
// answering for the agent names they replaced.
import type { ModelProvider, ModelTurnArgs, ModelTurnResult } from '@dudousxd/nestjs-agent-core';
import { InMemoryAgentStore } from '@dudousxd/nestjs-agent-testing';
import { Injectable } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AgentDepsFactory } from './agent-deps.factory.js';
import { AgentModule } from './agent.module.js';
import { AgentService } from './agent.service.js';
import { Agent, type AgentOptions } from './decorator/agent.decorator.js';
import { AiTool } from './decorator/ai-tool.decorator.js';
import { SystemPrompt } from './decorator/system-prompt.decorator.js';
import { HeaderActorResolver } from './resolver/header-actor-resolver.js';

@AiTool({ name: 'getWeather', kind: 'read', description: 'weather', input: z.object({}) })
@Injectable()
class GetWeatherTool {
  async execute() {
    return { sunny: true };
  }
}

@AiTool({ name: 'runSql', kind: 'read', description: 'sql', input: z.object({}) })
@Injectable()
class RunSqlTool {
  async execute() {
    return { rows: 1 };
  }
}

const ASSISTANT: AgentOptions = {
  name: 'assistant',
  description: 'The admin assistant',
  defaultPersona: 'general',
  personas: [
    { id: 'general', label: 'General' },
    {
      id: 'sql',
      label: 'SQL focused',
      description: 'Writes the query first',
      systemPrompt: (ctx) => `${ctx.basePrompt}\nSQL mode.`,
      aliases: ['sql-focused'],
    },
    {
      id: 'weather',
      label: 'Weather only',
      allowedTools: ['getWeather'],
      aliases: ['weather-bot'],
    },
  ],
};

@Agent(ASSISTANT)
@Injectable()
class AssistantAgent {
  @SystemPrompt()
  prompt(ctx: { persona?: { id: string } }): string {
    return `Base (${ctx.persona?.id ?? 'none'}).`;
  }
}

@Agent({ name: 'matcher', systemPrompt: 'Match units.' })
@Injectable()
class MatcherAgent {}

interface Seen {
  user: string;
  system: string;
  tools: string[];
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class RecordingModel implements ModelProvider {
  readonly seen: Seen[] = [];
  private readonly holds = new Map<string, ReturnType<typeof deferred>>();
  private readonly reachedBy = new Map<string, ReturnType<typeof deferred>>();

  hold(message: string): void {
    this.holds.set(message, deferred());
  }
  release(message: string): void {
    this.holds.get(message)?.resolve();
  }
  reached(message: string): Promise<void> {
    return this.entry(message).promise;
  }
  private entry(message: string) {
    let found = this.reachedBy.get(message);
    if (found === undefined) {
      found = deferred();
      this.reachedBy.set(message, found);
    }
    return found;
  }

  async runTurn(args: ModelTurnArgs): Promise<ModelTurnResult> {
    const user = [...args.messages].reverse().find((message) => message.role === 'user');
    const text = user?.content ?? '';
    this.seen.push({ user: text, system: args.system, tools: args.tools.map((tool) => tool.name) });
    this.entry(text).resolve();
    await this.holds.get(text)?.promise;
    await args.sink.write(
      new TextEncoder().encode(`${JSON.stringify({ kind: 'text', text: 'ok' })}\n`),
    );
    return { text: 'ok', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
  }
}

let app: NestExpressApplication | undefined;

async function boot() {
  const model = new RecordingModel();
  const store = new InMemoryAgentStore();
  const moduleRef = await Test.createTestingModule({
    imports: [
      AgentModule.forRoot({
        model,
        store,
        actorResolver: new HeaderActorResolver(),
        defaultAgent: 'assistant',
      }),
    ],
    providers: [GetWeatherTool, RunSqlTool, AssistantAgent, MatcherAgent],
  }).compile();
  const testApp = moduleRef.createNestApplication<NestExpressApplication>();
  await testApp.init();
  app = testApp;
  return {
    model,
    store,
    server: testApp.getHttpServer(),
    service: moduleRef.get(AgentService),
    factory: moduleRef.get(AgentDepsFactory),
  };
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

type Booted = Awaited<ReturnType<typeof boot>>;

function chat(booted: Booted, body: Record<string, unknown>) {
  return request(booted.server).post('/agent/chat').set('x-actor-id', 'u1').send(body);
}

async function thread(booted: Booted, threadId: string) {
  const res = await request(booted.server)
    .get(`/agent/threads/${threadId}`)
    .set('x-actor-id', 'u1');
  return res.body as {
    persona: string | null;
    messages: Array<{ role: string; persona?: string; agentName?: string }>;
  };
}

async function waitFor(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe('GET agents — the persona catalog', () => {
  it('lists each agent’s personas — id, label, description — and its default', async () => {
    const booted = await boot();
    const res = await request(booted.server).get('/agent/agents').set('x-actor-id', 'u1');
    expect(res.status).toBe(200);
    const assistant = res.body.find((entry: { name: string }) => entry.name === 'assistant');
    expect(assistant).toMatchObject({ isDefault: true, defaultPersona: 'general' });
    expect(assistant.personas).toEqual([
      { id: 'general', label: 'General' },
      { id: 'sql', label: 'SQL focused', description: 'Writes the query first' },
      { id: 'weather', label: 'Weather only' },
    ]);
    const matcher = res.body.find((entry: { name: string }) => entry.name === 'matcher');
    expect(matcher.personas).toBeUndefined();
    expect(matcher.defaultPersona).toBeUndefined();
  });
});

describe('POST chat { persona }', () => {
  it('runs under the agent’s default persona when the send names none', async () => {
    const booted = await boot();
    const res = await chat(booted, { message: 'hello' });
    expect(res.status).toBe(201);
    const threadId = res.headers['x-agent-thread-id'] as string;
    expect(booted.model.seen[0]?.system).toBe('Base (general).');
    const detail = await thread(booted, threadId);
    expect(detail.messages.map((message) => message.persona)).toEqual(['general', 'general']);
    // The default is not pinned — only a persona a send NAMED is.
    expect(detail.persona).toBeNull();
  });

  it('runs under the named persona, records it, and pins it on the thread', async () => {
    const booted = await boot();
    const res = await chat(booted, { message: 'count orders', persona: 'sql' });
    const threadId = res.headers['x-agent-thread-id'] as string;
    expect(booted.model.seen[0]?.system).toBe('Base (sql).\nSQL mode.');
    const detail = await thread(booted, threadId);
    expect(detail.persona).toBe('sql');
    expect(detail.messages.map((message) => [message.role, message.persona])).toEqual([
      ['user', 'sql'],
      ['assistant', 'sql'],
    ]);

    // The next send on that thread names none, and keeps answering as the pinned persona.
    await chat(booted, { message: 'again', threadId });
    expect(booted.model.seen[1]?.system).toBe('Base (sql).\nSQL mode.');
  });

  it('switching persona mid-thread re-pins it', async () => {
    const booted = await boot();
    const first = await chat(booted, { message: 'one', persona: 'sql' });
    const threadId = first.headers['x-agent-thread-id'] as string;
    await chat(booted, { message: 'two', threadId, persona: 'weather' });
    expect((await thread(booted, threadId)).persona).toBe('weather');
    expect(booted.model.seen[1]?.tools).toEqual(['getWeather']);
  });

  it('refuses a persona the agent does not declare, before creating anything', async () => {
    const booted = await boot();
    const res = await chat(booted, { message: 'hi', persona: 'nope' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('persona_not_found');
    expect(await booted.store.listThreads('u1')).toEqual([]);
  });

  it('refuses a persona sent to an agent that has none', async () => {
    const booted = await boot();
    const res = await chat(booted, { message: 'hi', agent: 'matcher', persona: 'sql' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('persona_not_found');
  });

  it('ignores a thread persona the agent of this send does not declare', async () => {
    const booted = await boot();
    const first = await chat(booted, { message: 'one', persona: 'sql' });
    const threadId = first.headers['x-agent-thread-id'] as string;
    const res = await chat(booted, { message: 'two', threadId, agent: 'matcher' });
    expect(res.status).toBe(201);
    expect(booted.model.seen[1]?.system).toBe('Match units.');
  });

  it('narrows the offered tools to the persona allow-list', async () => {
    const booted = await boot();
    await chat(booted, { message: 'weather?', persona: 'weather' });
    await chat(booted, { message: 'anything?' });
    expect(booted.model.seen[0]?.tools).toEqual(['getWeather']);
    expect(booted.model.seen[1]?.tools).toEqual(['getWeather', 'runSql']);
  });
});

describe('PATCH threads/:id { persona }', () => {
  it('pins, validates and clears the thread persona', async () => {
    const booted = await boot();
    const first = await chat(booted, { message: 'one' });
    const threadId = first.headers['x-agent-thread-id'] as string;
    const patch = (body: Record<string, unknown>) =>
      request(booted.server).patch(`/agent/threads/${threadId}`).set('x-actor-id', 'u1').send(body);

    expect((await patch({ persona: 'weather' })).status).toBe(200);
    expect((await thread(booted, threadId)).persona).toBe('weather');
    await chat(booted, { message: 'two', threadId });
    expect(booted.model.seen[1]?.tools).toEqual(['getWeather']);

    const refused = await patch({ persona: 'nope' });
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe('persona_not_found');

    expect((await patch({ persona: null })).status).toBe(200);
    expect((await thread(booted, threadId)).persona).toBeNull();
    await chat(booted, { message: 'three', threadId });
    expect(booted.model.seen[2]?.system).toBe('Base (general).');
  });
});

describe('a persona that replaced an agent (aliases)', () => {
  it('runs a send naming the old agent as the agent + persona that took it over', async () => {
    const booted = await boot();
    const res = await chat(booted, { message: 'old client', agent: 'sql-focused' });
    expect(res.status).toBe(201);
    const threadId = res.headers['x-agent-thread-id'] as string;
    expect(booted.model.seen[0]?.system).toBe('Base (sql).\nSQL mode.');
    const detail = await thread(booted, threadId);
    expect(detail.messages[1]).toMatchObject({ agentName: 'assistant', persona: 'sql' });
  });

  it('keeps a thread whose default agent is the old name answering, with no migration', async () => {
    const booted = await boot();
    const legacy = await booted.store.createThread({ actor: { id: 'u1' } });
    await booted.store.updateThread(legacy.id, { defaultAgent: 'weather-bot' });
    await booted.store.appendMessage({
      threadId: legacy.id,
      role: 'assistant',
      content: 'an answer from before',
      agentName: 'weather-bot',
    });
    const res = await chat(booted, { message: 'still there?', threadId: legacy.id });
    expect(res.status).toBe(201);
    expect(booted.model.seen[0]?.tools).toEqual(['getWeather']);
    const detail = await thread(booted, legacy.id);
    // The old row keeps the name it was written under; the new one names agent + persona.
    expect(detail.messages[0]?.agentName).toBe('weather-bot');
    expect(detail.messages.at(-1)).toMatchObject({ agentName: 'assistant', persona: 'weather' });
  });

  it('builds a run journaled under the old agent name on the agent + persona', async () => {
    const booted = await boot();
    const deps = booted.factory.forAgent('weather-bot');
    expect(deps.toolAllowList).toEqual(['getWeather']);
    const prompt =
      typeof deps.systemPrompt === 'function'
        ? await deps.systemPrompt({ actor: { id: 'u1' }, agentName: 'weather-bot' })
        : deps.systemPrompt;
    expect(prompt).toBe('Base (weather).');
  });
});

describe('a queued message carries its persona', () => {
  it('persists the persona the send resolved, and starts under it', async () => {
    const booted = await boot();
    booted.model.hold('first');
    const started = await booted.service.send({ actor: { id: 'u1' }, message: 'first' });
    await booted.model.reached('first');

    const queued = await booted.service.send({
      actor: { id: 'u1' },
      message: 'second',
      threadId: started.threadId,
      personaId: 'weather',
    });
    expect(queued.queued).toBe(true);
    const state = await booted.service.getQueue({ id: 'u1' }, started.threadId);
    expect(state.items[0]?.persona).toBe('weather');

    booted.model.release('first');
    await waitFor(() => booted.model.seen.length === 2, 'the queued message to start');
    expect(booted.model.seen[1]).toMatchObject({ user: 'second', tools: ['getWeather'] });
  });

  it('starts a message queued with no persona (as before personas) under the resolved one', async () => {
    const booted = await boot();
    booted.model.hold('first');
    const started = await booted.service.send({ actor: { id: 'u1' }, message: 'first' });
    await booted.model.reached('first');
    // What a release without personas wrote: an old agent name and no persona column at all.
    await booted.store.enqueueMessage({
      threadId: started.threadId,
      actor: { id: 'u1' },
      content: 'legacy',
      agentName: 'sql-focused',
    });
    booted.model.release('first');
    await waitFor(() => booted.model.seen.length === 2, 'the legacy queued message to start');
    expect(booted.model.seen[1]).toMatchObject({
      user: 'legacy',
      system: 'Base (sql).\nSQL mode.',
    });
  });
});
