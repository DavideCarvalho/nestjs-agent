// A human reply is journaled and re-read on every replay of the run it settles, so a payload the
// loop cannot read is not a failed request — it is a run that fails the same way forever. These
// drive the real HTTP route with bodies that type as `Record<string, string[]>` on the client and
// are anything but.
import {
  AGENT_RUNNER,
  type AgentRunner,
  type ElicitationReply,
  type HumanReply,
  resolveElicitation,
} from '@dudousxd/nestjs-agent-core';
import { FakeModelProvider, InMemoryAgentStore } from '@dudousxd/nestjs-agent-testing';
import { Injectable } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentModule } from '../agent.module.js';
import { Agent } from '../decorator/agent.decorator.js';
import { HeaderActorResolver } from '../resolver/header-actor-resolver.js';

@Agent({ name: 'default', systemPrompt: 'validation test agent', model: 'fake-1' })
@Injectable()
class DefaultAgent {}

let app: NestExpressApplication | undefined;

interface Booted {
  app: NestExpressApplication;
  signalled: { toolCallId: string; reply: HumanReply }[];
}

/** A thread owned by `u1` with one parked question set, and a runner that records what it is sent. */
async function boot(): Promise<Booted> {
  const store = new InMemoryAgentStore();
  const thread = await store.createThread({ actor: { id: 'u1', roles: ['ADMIN'] } });
  const message = await store.appendMessage({
    threadId: thread.id,
    role: 'assistant',
    content: 'a few questions',
    runId: 'run-a',
  });
  await store.recordToolCall({
    toolCallId: 'call-1',
    messageId: message.id,
    toolName: 'ask',
    toolType: 'action',
    input: { questions: [] },
    status: 'pending_approval',
    runId: 'run-a',
  });

  const signalled: { toolCallId: string; reply: HumanReply }[] = [];
  const runner: AgentRunner = {
    start: async () => ({ runId: 'run-a' }),
    signal: async (_runId, toolCallId, reply) => {
      signalled.push({ toolCallId, reply });
    },
    cancel: async () => {},
  };

  const moduleRef = await Test.createTestingModule({
    imports: [
      AgentModule.forRoot({
        model: new FakeModelProvider(() => ({ text: 'ok' })),
        store,
        actorResolver: new HeaderActorResolver(),
        defaultAgent: 'default',
      }),
    ],
    providers: [DefaultAgent],
  })
    .overrideProvider(AGENT_RUNNER)
    .useValue(runner)
    .compile();
  const testApp = moduleRef.createNestApplication<NestExpressApplication>();
  await testApp.init();
  app = testApp;
  return { app: testApp, signalled };
}

function post(booted: Booted, path: string, body: unknown) {
  return request(booted.app.getHttpServer())
    .post(`/agent/tool-call/${path}`)
    .set('x-actor-id', 'u1')
    .send(body as object);
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('answers submitted for a parked question set', () => {
  it('is what the loop would choke on — the reason the route has to refuse it', () => {
    expect(() =>
      resolveElicitation(
        {
          id: 'call-1',
          source: 'ask',
          questions: [
            { id: 'q1', prompt: 'which?', options: [{ value: 'a', label: 'A' }], defaults: ['a'] },
          ],
        },
        { answers: { q1: 'oops' } as unknown as Record<string, string[]> },
      ),
    ).toThrow(TypeError);
  });

  it('refuses a bare string where a question takes a list of chosen values', async () => {
    const booted = await boot();

    const res = await post(booted, 'answer', { toolCallId: 'call-1', answers: { q1: 'oops' } });

    expect(res.status).toBe(400);
    expect(booted.signalled).toEqual([]);
  });

  it('refuses values that are not strings', async () => {
    const booted = await boot();

    const res = await post(booted, 'answer', { toolCallId: 'call-1', answers: { q1: [1, 2] } });

    expect(res.status).toBe(400);
    expect(booted.signalled).toEqual([]);
  });

  it('refuses an answers payload that is not an object of questions at all', async () => {
    const booted = await boot();

    for (const answers of ['oops', 42, ['a'], null]) {
      const res = await post(booted, 'answer', { toolCallId: 'call-1', answers });
      expect(res.status).toBe(400);
    }
    expect(booted.signalled).toEqual([]);
  });

  it('refuses an unbounded answer value', async () => {
    const booted = await boot();

    const res = await post(booted, 'answer', {
      toolCallId: 'call-1',
      answers: { q1: ['x'.repeat(100_000)] },
    });

    expect(res.status).toBe(400);
    expect(booted.signalled).toEqual([]);
  });

  it('refuses more questions, or more values for one question, than a reply may carry', async () => {
    const booted = await boot();

    const tooManyQuestions = Object.fromEntries(
      Array.from({ length: 200 }, (_, index) => [`q${index}`, ['a']]),
    );
    expect(
      (await post(booted, 'answer', { toolCallId: 'call-1', answers: tooManyQuestions })).status,
    ).toBe(400);

    const tooManyValues = { q1: Array.from({ length: 500 }, () => 'a') };
    expect(
      (await post(booted, 'answer', { toolCallId: 'call-1', answers: tooManyValues })).status,
    ).toBe(400);

    expect(booted.signalled).toEqual([]);
  });

  it('still delivers a well-formed submission, and an empty one', async () => {
    const booted = await boot();

    expect(
      (await post(booted, 'answer', { toolCallId: 'call-1', answers: { q1: ['a', 'b'] } })).status,
    ).toBe(201);
    expect((await post(booted, 'answer', { toolCallId: 'call-1' })).status).toBe(201);

    expect(booted.signalled).toEqual([
      { toolCallId: 'call-1', reply: { answers: { q1: ['a', 'b'] }, answeredByRef: 'u1' } },
      { toolCallId: 'call-1', reply: { answers: {}, answeredByRef: 'u1' } },
    ]);
  });

  it('carries a question literally named __proto__ as an ordinary answer', async () => {
    const booted = await boot();
    // Only JSON.parse produces an own `__proto__` property; an object literal would assign the
    // prototype instead, which is exactly the trap the validator has to avoid re-creating.
    const answers: unknown = JSON.parse('{"__proto__":["a"]}');

    const res = await post(booted, 'answer', { toolCallId: 'call-1', answers });

    expect(res.status).toBe(201);
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
    const reply = booted.signalled[0]?.reply as ElicitationReply;
    expect(Object.entries(reply.answers)).toEqual([['__proto__', ['a']]]);
  });
});

describe('the reason a rejection carries', () => {
  it('refuses an unbounded reason, which the model reads back as a tool result', async () => {
    const booted = await boot();

    const res = await post(booted, 'reject', {
      toolCallId: 'call-1',
      reason: 'x'.repeat(100_000),
    });

    expect(res.status).toBe(400);
    expect(booted.signalled).toEqual([]);
  });

  it('refuses a reason that is not a string', async () => {
    const booted = await boot();

    const res = await post(booted, 'reject', { toolCallId: 'call-1', reason: { nope: true } });

    expect(res.status).toBe(400);
    expect(booted.signalled).toEqual([]);
  });

  it('still delivers a short reason, and an omitted one', async () => {
    const booted = await boot();

    expect((await post(booted, 'reject', { toolCallId: 'call-1', reason: 'not now' })).status).toBe(
      201,
    );
    expect((await post(booted, 'reject', { toolCallId: 'call-1' })).status).toBe(201);

    expect(booted.signalled).toEqual([
      { toolCallId: 'call-1', reply: { approved: false, reason: 'not now' } },
      { toolCallId: 'call-1', reply: { approved: false } },
    ]);
  });
});

describe('the toolCallId a decision names', () => {
  it('refuses anything that is not a non-empty string, rather than querying the store with it', async () => {
    const booted = await boot();

    for (const toolCallId of [undefined, '', 42, { $ne: null }]) {
      expect((await post(booted, 'approve', { toolCallId })).status).toBe(400);
    }
    expect(booted.signalled).toEqual([]);
  });
});
