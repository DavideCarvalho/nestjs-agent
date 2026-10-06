import 'reflect-metadata';
import {
  Agent,
  AgentModule,
  AgentService,
  HeaderActorResolver,
  SystemPromptContributor,
} from '@dudousxd/nestjs-agent';
import type { Actor, AgentStreamEvent } from '@dudousxd/nestjs-agent-core';
import { InMemoryAgentStore } from '@dudousxd/nestjs-agent-testing';
import { type INestApplication, Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { openCode } from './engine.js';
import type { OpenCodeHost, OpenCodeServer, OpenCodeTurnContext } from './host.js';
import { FakeOpenCode, type FakeScript } from './testing/fake-opencode.js';

const actor: Actor = { id: 'u1', roles: ['ADMIN'] };

@Agent({ name: 'flippy', systemPrompt: 'You are Flippy.' })
@Injectable()
class FlippyAgent {}

@Injectable()
class TimeContributor {
  @SystemPromptContributor()
  section() {
    return 'Today is Tuesday.';
  }
}

class TestHost implements OpenCodeHost {
  bootId = 'boot-1';
  readonly sessionsAsked: OpenCodeTurnContext[] = [];
  constructor(readonly fake: FakeOpenCode) {}

  async server(): Promise<OpenCodeServer> {
    return { client: this.fake, key: 'tenant-1', bootId: this.bootId };
  }

  async session(context: OpenCodeTurnContext) {
    this.sessionsAsked.push(context);
    return {
      location: { directory: '/work/u1' },
      permissions: [{ action: '*', resource: '*', effect: 'deny' as const }],
    };
  }

  async instructions() {
    return { 'flippy.profile': 'Davi writes short emails.' };
  }
}

async function boot(script?: FakeScript) {
  const fake = new FakeOpenCode(script);
  const host = new TestHost(fake);
  const store = new InMemoryAgentStore();
  const moduleRef = await Test.createTestingModule({
    imports: [
      AgentModule.forRoot({
        engine: openCode({ host }),
        store,
        actorResolver: new HeaderActorResolver(),
      }),
    ],
    providers: [FlippyAgent, TimeContributor],
  }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return { app, fake, host, store, service: app.get(AgentService) };
}

async function frames(service: AgentService, runId: string): Promise<AgentStreamEvent[]> {
  const decoder = new TextDecoder();
  let text = '';
  for await (const chunk of service.subscribe(runId)) text += decoder.decode(chunk);
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as AgentStreamEvent);
}

/** Frames until one matching `until` arrives (for runs parked on a person). */
async function framesUntil(
  service: AgentService,
  runId: string,
  until: (f: AgentStreamEvent) => boolean,
): Promise<AgentStreamEvent[]> {
  const decoder = new TextDecoder();
  const out: AgentStreamEvent[] = [];
  let buffer = '';
  for await (const chunk of service.subscribe(runId)) {
    buffer += decoder.decode(chunk);
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines.filter(Boolean)) {
      const frame = JSON.parse(line) as AgentStreamEvent;
      out.push(frame);
      if (until(frame)) return out;
    }
  }
  return out;
}

const text = (fs: AgentStreamEvent[]) =>
  fs.flatMap((f) => (f.kind === 'text' ? [f.text] : [])).join('');

describe('openCode engine', () => {
  let app: INestApplication | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('runs a turn on an OpenCode session and streams it in the library protocol', async () => {
    const built = await boot();
    app = built.app;
    const { runId, threadId } = await built.service.chat({ actor, message: 'hello' });
    const fs = await frames(built.service, runId);

    expect(text(fs)).toBe('echo: hello');
    expect(fs.map((f) => f.kind)).toEqual(['step-start', 'text', 'step-finish']);
    expect(fs.find((f) => f.kind === 'step-finish')).toMatchObject({
      usage: { inputTokens: 10, outputTokens: 5 },
    });

    const thread = await built.store.getThread(threadId);
    expect(thread?.messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'hello'],
      ['assistant', 'echo: hello'],
    ]);
    expect(thread?.title).toBe('hello');
    expect(thread?.activeRunId ?? null).toBeNull();
  });

  it("gives the session the agent's prompt, its contributors and the host's entries", async () => {
    const built = await boot();
    app = built.app;
    const { runId } = await built.service.chat({ actor, message: 'hi' });
    await frames(built.service, runId);

    const [create] = built.fake.callsOf('session.create');
    expect(create?.args).toMatchObject({
      location: { directory: '/work/u1' },
      permissions: [{ action: '*', resource: '*', effect: 'deny' }],
    });
    const entries = Object.fromEntries(
      built.fake.callsOf('session.instructions.entry.put').map((c) => [c.args.key, c.args.value]),
    );
    expect(entries['aviary.system']).toBe('You are Flippy.\n\nToday is Tuesday.');
    expect(entries['flippy.profile']).toBe('Davi writes short emails.');
  });

  it('keeps one session per thread, and a new one (told the conversation) after a restart', async () => {
    const built = await boot();
    app = built.app;
    const first = await built.service.chat({ actor, message: 'one' });
    await frames(built.service, first.runId);
    const second = await built.service.chat({ actor, message: 'two', threadId: first.threadId });
    await frames(built.service, second.runId);
    expect(built.fake.callsOf('session.create')).toHaveLength(1);
    expect(built.fake.callsOf('session.prompt').map((c) => c.args.sessionID)).toEqual([
      'ses_1',
      'ses_1',
    ]);

    built.host.bootId = 'boot-2';
    const third = await built.service.chat({ actor, message: 'three', threadId: first.threadId });
    await frames(built.service, third.runId);
    expect(built.fake.callsOf('session.create')).toHaveLength(2);
    const history = built.fake
      .callsOf('session.instructions.entry.put')
      .find((c) => c.args.key === 'aviary.history');
    expect(history?.args.sessionID).toBe('ses_2');
    expect(history?.args.value).toContain(
      'User: one\nAssistant: echo: one\nUser: two\nAssistant: echo: two',
    );
  });

  it('nests code-mode company calls under execute and records them on the message', async () => {
    const built = await boot(async (t) => {
      t.emit('session.tool.input.started', { id: 'call_1', name: 'execute' });
      t.emit('session.tool.called', {
        id: 'call_1',
        input: { code: 'tools.company.gmail__search()' },
      });
      t.emit('session.tool.progress', {
        id: 'call_1',
        metadata: {
          toolCalls: [{ tool: 'company.gmail__search', status: 'running', input: { q: 'x' } }],
        },
      });
      t.emit('session.tool.success', {
        id: 'call_1',
        metadata: { toolCalls: [{ tool: 'company.gmail__search', status: 'completed' }] },
      });
      t.emit('session.step.ended', { tokens: { input: 3, output: 1 } });
      t.emit('session.text.delta', { delta: 'Found 2 threads.' });
      t.emit('session.step.ended', { tokens: { input: 4, output: 2 } });
      t.succeed();
    });
    app = built.app;
    const { runId, threadId } = await built.service.chat({ actor, message: 'search' });
    const fs = await frames(built.service, runId);

    expect(fs).toContainEqual({
      kind: 'tool-input-available',
      id: 'call_1.0',
      name: 'company.gmail__search',
      input: { q: 'x' },
      toolKind: 'read',
      parentId: 'call_1',
    });
    expect(fs).toContainEqual({ kind: 'tool-output', id: 'call_1', output: { ok: true } });
    expect(fs.filter((f) => f.kind === 'step-start')).toHaveLength(2);

    const answer = (await built.store.getThread(threadId))?.messages.at(-1);
    expect(answer?.content).toBe('Found 2 threads.');
    expect(answer?.toolCalls?.map((c) => [c.id, c.name, c.parentId])).toEqual([
      ['call_1', 'execute', undefined],
      ['call_1.0', 'company.gmail__search', 'call_1'],
    ]);
    expect(answer?.usage).toMatchObject({ inputTokens: 7, outputTokens: 3 });
  });

  it('parks on an OpenCode permission until the approve route decides it', async () => {
    const built = await boot(async (t) => {
      t.emit('session.text.delta', { delta: 'Sending it.' });
      t.emit('permission.asked', {
        id: 'per_1',
        action: 'company.gmail__send_email',
        metadata: { input: { to: 'priya@harbor.com' } },
      });
      const reply = await t.next('permission.reply');
      t.emit('session.text.delta', {
        delta: reply.args.decision === 'once' ? 'Sent.' : 'Not sent.',
      });
      t.succeed();
    });
    app = built.app;
    const { runId, threadId } = await built.service.chat({ actor, message: 'send it' });
    const asked = await framesUntil(built.service, runId, (f) => f.kind === 'approval-requested');
    expect(asked.slice(-2)).toEqual([
      {
        kind: 'tool-input-available',
        id: 'per_1',
        name: 'company.gmail__send_email',
        input: { to: 'priya@harbor.com' },
        toolKind: 'action',
      },
      { kind: 'approval-requested', id: 'per_1', approver: 'requester' },
    ]);

    await built.service.approve(actor, 'per_1', { via: 'web' });
    const fs = await frames(built.service, runId);
    expect(built.fake.callsOf('permission.reply')[0]?.args).toMatchObject({
      requestID: 'per_1',
      decision: 'once',
    });
    expect(fs).toContainEqual(
      expect.objectContaining({
        kind: 'approval-settled',
        id: 'per_1',
        status: 'approved',
        decidedVia: 'web',
      }),
    );
    expect(text(fs)).toContain('Sent.');

    const messages = (await built.store.getThread(threadId))?.messages ?? [];
    expect(messages.map((m) => m.content)).toEqual(['send it', 'Sending it.', 'Sent.']);
    expect(messages[1]?.toolResults).toEqual([
      { id: 'per_1', name: 'company.gmail__send_email', output: { approved: true } },
    ]);
  });

  it('tells OpenCode why when the person rejects', async () => {
    const built = await boot(async (t) => {
      t.emit('permission.asked', { id: 'per_1', action: 'company.gmail__send_email' });
      await t.next('permission.reply');
      t.succeed();
    });
    app = built.app;
    const { runId } = await built.service.chat({ actor, message: 'send it' });
    await framesUntil(built.service, runId, (f) => f.kind === 'approval-requested');
    await built.service.reject(actor, 'per_1', 'wrong recipient');
    const fs = await frames(built.service, runId);

    const reply = built.fake.callsOf('permission.reply')[0]?.args;
    expect(reply).toMatchObject({ decision: 'reject' });
    expect(String(reply?.message)).toContain('wrong recipient');
    expect(fs).toContainEqual({
      kind: 'tool-output-denied',
      id: 'per_1',
      reason: 'wrong recipient',
    });
  });

  it('asks a form as an elicitation and replies with typed answers', async () => {
    const built = await boot(async (t) => {
      t.emit('form.created', {
        form: {
          id: 'frm_1',
          sessionID: t.sessionId,
          title: 'Before I draft',
          fields: [
            {
              key: 'tone',
              title: 'Tone?',
              options: [
                { value: 'formal', label: 'Formal' },
                { value: 'casual', label: 'Casual' },
              ],
            },
            { key: 'words', title: 'How many words?', type: 'number' },
          ],
        },
      });
      await t.next('session.form.reply');
      t.emit('session.text.delta', { delta: 'Drafted.' });
      t.succeed();
    });
    app = built.app;
    const { runId } = await built.service.chat({ actor, message: 'draft' });
    const asked = await framesUntil(built.service, runId, (f) => f.kind === 'elicitation');
    expect(asked.at(-1)).toMatchObject({
      kind: 'elicitation',
      id: 'frm_1',
      request: {
        source: 'ask',
        preamble: 'Before I draft',
        questions: [{ id: 'tone' }, { id: 'words' }],
      },
    });

    await built.service.answer(actor, 'frm_1', { tone: ['casual'], words: ['120'] });
    const fs = await frames(built.service, runId);
    expect(built.fake.callsOf('session.form.reply')[0]?.args.answer).toEqual({
      tone: 'casual',
      words: 120,
    });
    expect(fs).toContainEqual(expect.objectContaining({ kind: 'tool-output', id: 'frm_1' }));
    expect(text(fs)).toBe('Drafted.');
  });

  it('interrupts the session on cancel and ends the stream as cancelled', async () => {
    const built = await boot(async (t) => {
      t.emit('session.text.delta', { delta: 'Working…' });
      // Never finishes on its own.
    });
    app = built.app;
    const { runId } = await built.service.chat({ actor, message: 'long task' });
    await framesUntil(built.service, runId, (f) => f.kind === 'text');
    await built.service.cancel(actor, runId);
    const fs = await frames(built.service, runId);

    expect(built.fake.callsOf('session.interrupt')).toHaveLength(1);
    expect(fs.at(-1)).toEqual({ kind: 'cancelled' });
  });

  it('fails the stream with a typed error when the execution fails', async () => {
    const built = await boot(async (t) => {
      t.emit('session.execution.failed', { error: { message: 'provider overloaded' } });
    });
    app = built.app;
    const { runId } = await built.service.chat({ actor, message: 'hi' });
    await expect(frames(built.service, runId)).rejects.toThrow('provider overloaded');
  });
});

describe('AgentModule wiring', () => {
  it('needs a model or an engine', () => {
    expect(() => AgentModule.forRoot({ actorResolver: new HeaderActorResolver() })).toThrow(
      /set `model`.*or `engine`/,
    );
  });

  it('refuses durable with an engine', () => {
    const host = new TestHost(new FakeOpenCode());
    expect(() =>
      AgentModule.forRoot({
        engine: openCode({ host }),
        durable: true,
        actorResolver: new HeaderActorResolver(),
      }),
    ).toThrow(/opencode/);
  });
});
