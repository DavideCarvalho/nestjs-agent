// Sending while a turn is still running queues the message on the thread, server-side, and the next
// queued message starts as soon as the running turn settles — like typing ahead in a chat app.
import type {
  ModelProvider,
  ModelTurnArgs,
  ModelTurnResult,
  QuotaProvider,
  QuotaReport,
} from '@dudousxd/nestjs-agent-core';
import { InMemoryAgentStore } from '@dudousxd/nestjs-agent-testing';
import { ConflictException, Injectable } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentModule } from '../agent.module.js';
import { AgentService } from '../agent.service.js';
import { Agent } from '../decorator/agent.decorator.js';
import { HeaderActorResolver } from '../resolver/header-actor-resolver.js';

@Agent({ name: 'default', systemPrompt: 'queue test agent', model: 'fake-1' })
@Injectable()
class DefaultAgent {}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Answers `re: <message>`; a message can be held mid-turn, or made to fail. */
class ScriptedModel implements ModelProvider {
  readonly seen: string[] = [];
  readonly failing = new Set<string>();
  private readonly holds = new Map<string, Deferred>();
  private readonly entered = new Map<string, Deferred>();

  hold(message: string): void {
    this.holds.set(message, deferred());
  }

  release(message: string): void {
    this.holds.get(message)?.resolve();
  }

  /** Resolves once a turn answering `message` has reached the model. */
  reached(message: string): Promise<void> {
    return this.enteredFor(message).promise;
  }

  private enteredFor(message: string): Deferred {
    let entry = this.entered.get(message);
    if (entry === undefined) {
      entry = deferred();
      this.entered.set(message, entry);
    }
    return entry;
  }

  async runTurn(args: ModelTurnArgs): Promise<ModelTurnResult> {
    const last = [...args.messages].reverse().find((message) => message.role === 'user');
    const message = last?.content ?? '';
    this.seen.push(message);
    this.enteredFor(message).resolve();
    await this.holds.get(message)?.promise;
    if (this.failing.has(message)) {
      throw new Error(`model failed on ${message}`);
    }
    const text = `re: ${message}`;
    await args.sink.write(new TextEncoder().encode(`${JSON.stringify({ kind: 'text', text })}\n`));
    return { text, toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
  }
}

class SwitchableQuota implements QuotaProvider {
  blocked = false;
  async report(): Promise<QuotaReport> {
    return {
      windows: [{ period: 'day', usedTokens: 0, usedUsd: 0 }],
      ...(this.blocked ? { blocked: { period: 'day', reason: 'Daily budget spent' } } : {}),
    };
  }
}

let app: NestExpressApplication | undefined;

async function boot(options: { quota?: QuotaProvider } = {}) {
  const model = new ScriptedModel();
  const store = new InMemoryAgentStore();
  const moduleRef = await Test.createTestingModule({
    imports: [
      AgentModule.forRoot({
        model,
        store,
        actorResolver: new HeaderActorResolver(),
        defaultAgent: 'default',
        ...(options.quota !== undefined ? { quota: options.quota } : {}),
      }),
    ],
    providers: [DefaultAgent],
  }).compile();
  const testApp = moduleRef.createNestApplication<NestExpressApplication>();
  await testApp.init();
  app = testApp;
  const thread = await store.createThread({ actor: { id: 'u1' } });
  return {
    model,
    store,
    threadId: thread.id,
    server: testApp.getHttpServer(),
    service: moduleRef.get(AgentService),
  };
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

type Server = Awaited<ReturnType<typeof boot>>['server'];

function send(server: Server, body: Record<string, unknown>, actor = 'u1') {
  return request(server).post('/agent/chat').set('x-actor-id', actor).send(body);
}

/** Every `data:` event of an SSE body, parsed, plus the named terminal. */
function eventsOf(text: string): { events: Array<Record<string, unknown>>; terminal?: string } {
  const events: Array<Record<string, unknown>> = [];
  let terminal: string | undefined;
  for (const block of text.split('\n\n')) {
    let name: string | undefined;
    let data: string | undefined;
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) name = line.slice(7);
      else if (line.startsWith('data: ')) data = line.slice(6);
    }
    if (name === 'done' || name === 'error') terminal = name;
    else if (name === undefined && data !== undefined) events.push(JSON.parse(data));
  }
  return terminal !== undefined ? { events, terminal } : { events };
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 3000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out; last value: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** The thread's transcript as `role: content` lines, once no turn is running on it. */
async function settledTranscript(store: InMemoryAgentStore, threadId: string, count: number) {
  const thread = await until(
    () => store.getThread(threadId),
    (value) =>
      value !== null &&
      value.activeRunId === undefined &&
      value.messages.filter((message) => message.role === 'assistant').length >= count,
  );
  return thread?.messages.map((message) => `${message.role}: ${message.content}`) ?? [];
}

describe('chat message queue', () => {
  it('queues a send made while a turn runs, and starts it when that turn completes', async () => {
    const { model, store, threadId, server } = await boot();
    model.hold('first');
    const first = send(server, { threadId, message: 'first' }).then((res) => res);
    await model.reached('first');

    const queued = await send(server, { threadId, message: 'second' });
    expect(queued.status).toBe(202);
    expect(queued.body).toMatchObject({
      queued: true,
      threadId,
      position: 0,
      queue: { items: [{ content: 'second' }], paused: null },
    });
    const messageId = queued.body.messageId as string;

    const listed = await request(server)
      .get(`/agent/threads/${threadId}/queue`)
      .set('x-actor-id', 'u1');
    expect(listed.body).toMatchObject({ items: [{ id: messageId, content: 'second' }] });

    model.release('first');
    const { events, terminal } = eventsOf((await first).text);
    expect(terminal).toBe('done');
    const queueFrames = events.filter((event) => event.kind === 'queue');
    // Announced when it was queued, then handed the thread just before the stream ended.
    expect(queueFrames[0]).toMatchObject({ queue: { items: [{ id: messageId }] } });
    expect(queueFrames.at(-1)).toEqual({
      kind: 'queue',
      queue: { items: [], paused: null },
      started: { messageId, runId: messageId },
    });
    expect(events.at(-1)).toBe(queueFrames.at(-1));

    expect(await settledTranscript(store, threadId, 2)).toEqual([
      'user: first',
      'assistant: re: first',
      'user: second',
      'assistant: re: second',
    ]);
    const detail = await request(server).get(`/agent/threads/${threadId}`).set('x-actor-id', 'u1');
    expect(detail.body).toMatchObject({ activeRunId: null, queue: { items: [], paused: null } });
  });

  it('drains several queued messages in order, one turn at a time', async () => {
    const { model, store, threadId, server } = await boot();
    model.hold('first');
    const first = send(server, { threadId, message: 'first' }).then((res) => res);
    await model.reached('first');
    expect((await send(server, { threadId, message: 'a' })).body.position).toBe(0);
    expect((await send(server, { threadId, message: 'b' })).body.position).toBe(1);

    model.release('first');
    await first;
    expect(await settledTranscript(store, threadId, 3)).toEqual([
      'user: first',
      'assistant: re: first',
      'user: a',
      'assistant: re: a',
      'user: b',
      'assistant: re: b',
    ]);
  });

  it('starts at once, streaming, when nothing is running', async () => {
    const { threadId, server } = await boot();
    const res = await send(server, { threadId, message: 'hi', mode: 'queue' });
    // Queue mode always answers 202; with an idle thread it has already started.
    expect(res.status).toBe(202);
    expect(res.body.runId).toBe(res.body.messageId);

    const auto = await send(server, { threadId: res.body.threadId, message: 'again' });
    expect(auto.status).toBe(201);
    expect(auto.headers['content-type']).toContain('text/event-stream');
  });

  it('pauses behind a failed turn, keeping the queue, and resumes on request', async () => {
    const { model, store, threadId, server } = await boot();
    model.hold('first');
    model.failing.add('first');
    const first = send(server, { threadId, message: 'first' }).then((res) => res);
    await model.reached('first');
    await send(server, { threadId, message: 'second' });

    model.release('first');
    const { events, terminal } = eventsOf((await first).text);
    expect(terminal).toBe('error');
    expect(events.at(-1)).toMatchObject({
      kind: 'queue',
      queue: { items: [{ content: 'second' }], paused: { reason: 'run_failed' } },
    });
    expect(events.at(-1)?.started).toBeUndefined();

    const paused = await request(server)
      .get(`/agent/threads/${threadId}/queue`)
      .set('x-actor-id', 'u1');
    expect(paused.body.paused).toMatchObject({
      reason: 'run_failed',
      message: 'model failed on first',
    });
    expect(model.seen).not.toContain('second');

    const resumed = await request(server)
      .post(`/agent/threads/${threadId}/queue/resume`)
      .set('x-actor-id', 'u1');
    expect(resumed.status).toBe(201);
    expect(resumed.body).toMatchObject({ items: [], paused: null });
    expect(typeof resumed.body.runId).toBe('string');
    const transcript = await settledTranscript(store, threadId, 1);
    expect(transcript.slice(-2)).toEqual(['user: second', 'assistant: re: second']);
  });

  it('pauses behind a Stop', async () => {
    const { model, store, threadId, server } = await boot();
    model.hold('first');
    const first = send(server, { threadId, message: 'first' }).then((res) => res);
    await model.reached('first');
    await send(server, { threadId, message: 'second' });
    const runId = (await store.activeRunForThread(threadId)) as string;

    await request(server).post(`/agent/chat/${runId}/cancel`).set('x-actor-id', 'u1');
    model.release('first');
    const { events } = eventsOf((await first).text);
    // The Stop reached a turn whose last model call was already answering: it completes, and the
    // queue behind it pauses all the same.
    expect(events.filter((event) => event.kind === 'queue').at(-1)).toMatchObject({
      queue: { paused: { reason: 'cancelled' } },
    });
    const state = await request(server)
      .get(`/agent/threads/${threadId}/queue`)
      .set('x-actor-id', 'u1');
    expect(state.body).toMatchObject({
      items: [{ content: 'second' }],
      paused: { reason: 'cancelled' },
    });
    expect(model.seen).not.toContain('second');
  });

  it('an interrupt cancels the running turn and runs next, ahead of the queue', async () => {
    const { model, store, threadId, server } = await boot();
    model.hold('first');
    const first = send(server, { threadId, message: 'first' }).then((res) => res);
    await model.reached('first');
    const runId = (await store.activeRunForThread(threadId)) as string;
    await send(server, { threadId, message: 'later' });

    const interrupt = await send(server, { threadId, message: 'now', mode: 'interrupt' });
    expect(interrupt.status).toBe(202);
    expect(interrupt.body).toMatchObject({
      interrupting: runId,
      position: 0,
      queue: { items: [{ content: 'now', interrupt: true }, { content: 'later' }] },
    });

    model.release('first');
    const { events } = eventsOf((await first).text);
    expect(events.filter((event) => event.kind === 'queue').at(-1)).toMatchObject({
      started: { messageId: interrupt.body.messageId },
      queue: { items: [{ content: 'later' }], paused: null },
    });
    await until(
      async () => model.seen,
      (seen) => seen.includes('later'),
    );
    expect(model.seen).toEqual(['first', 'now', 'later']);
    const transcript = await settledTranscript(store, threadId, 2);
    expect(transcript.slice(-4)).toEqual([
      'user: now',
      'assistant: re: now',
      'user: later',
      'assistant: re: later',
    ]);
  });

  it('edits, reorders and removes queued messages — only the thread owner may', async () => {
    const { model, store, threadId, server } = await boot();
    model.hold('first');
    const first = send(server, { threadId, message: 'first' }).then((res) => res);
    await model.reached('first');
    const a = (await send(server, { threadId, message: 'a' })).body.messageId as string;
    const b = (await send(server, { threadId, message: 'b' })).body.messageId as string;
    const c = (await send(server, { threadId, message: 'c' })).body.messageId as string;

    const moved = await request(server)
      .patch(`/agent/queue/${b}`)
      .set('x-actor-id', 'u1')
      .send({ position: 0 });
    expect(moved.body.items.map((item: { id: string }) => item.id)).toEqual([b, a, c]);
    const edited = await request(server)
      .patch(`/agent/queue/${a}`)
      .set('x-actor-id', 'u1')
      .send({ message: 'a, edited' });
    expect(edited.body.items[1]).toMatchObject({ id: a, content: 'a, edited' });
    const removed = await request(server).delete(`/agent/queue/${c}`).set('x-actor-id', 'u1');
    expect(removed.body.items.map((item: { id: string }) => item.id)).toEqual([b, a]);

    const stranger = await request(server)
      .patch(`/agent/queue/${a}`)
      .set('x-actor-id', 'intruder')
      .send({ message: 'hijacked' });
    expect(stranger.status).toBe(403);
    expect(
      (await request(server).delete(`/agent/queue/${a}`).set('x-actor-id', 'intruder')).status,
    ).toBe(403);
    expect((await send(server, { threadId, message: 'sneak' }, 'intruder')).status).toBe(403);
    expect((await request(server).delete(`/agent/queue/${c}`).set('x-actor-id', 'u1')).status).toBe(
      404,
    );

    model.release('first');
    await first;
    const transcript = await settledTranscript(store, threadId, 3);
    expect(transcript.filter((line) => line.startsWith('user:'))).toEqual([
      'user: first',
      'user: b',
      'user: a, edited',
    ]);
  });

  it('checks the quota when a queued message starts, pausing the queue when it is spent', async () => {
    const quota = new SwitchableQuota();
    const { model, threadId, server } = await boot({ quota });
    model.hold('first');
    const first = send(server, { threadId, message: 'first' }).then((res) => res);
    await model.reached('first');
    await send(server, { threadId, message: 'second' });
    quota.blocked = true;

    model.release('first');
    const { events } = eventsOf((await first).text);
    expect(events.at(-1)).toMatchObject({
      kind: 'queue',
      queue: { paused: { reason: 'quota_exceeded', message: 'Daily budget spent' } },
    });
    expect(model.seen).not.toContain('second');

    // At enqueue too: a spent budget refuses the send outright.
    expect((await send(server, { threadId, message: 'third' })).status).toBe(429);
  });

  it('replaces a holder that is no longer running instead of queueing behind it for ever', async () => {
    const { store, threadId, server } = await boot();
    // What a process that crashed mid-turn leaves behind.
    await store.setActiveStream(threadId, 'ghost-run');
    const res = await send(server, { threadId, message: 'hello' });
    expect(res.status).toBe(201);
    expect(eventsOf(res.text).terminal).toBe('done');
    expect(await settledTranscript(store, threadId, 1)).toEqual([
      'user: hello',
      'assistant: re: hello',
    ]);
  });

  it('keeps AgentService.chat() a start-or-refuse call for in-process callers', async () => {
    const { model, store, threadId, server, service } = await boot();
    model.hold('first');
    const first = send(server, { threadId, message: 'first' }).then((res) => res);
    await model.reached('first');

    await expect(
      service.chat({ actor: { id: 'u1' }, threadId, message: 'second' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(await store.listQueue(threadId)).toEqual([]);
    model.release('first');
    await first;
  });

  it('refuses to regenerate while a turn is running', async () => {
    const { model, threadId, server } = await boot();
    model.hold('first');
    const first = send(server, { threadId, message: 'first' }).then((res) => res);
    await model.reached('first');
    const res = await send(server, { threadId, message: '', regenerate: true });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('run_active');
    model.release('first');
    await first;
  });

  it('rejects an unknown mode', async () => {
    const { threadId, server } = await boot();
    expect((await send(server, { threadId, message: 'x', mode: 'later' })).status).toBe(400);
  });
});
