// The chat message queue under the durable runner: the settling turn hands the thread to the next
// queued message from inside its own workflow body (a journaled decision + a replay-safe spawn), and
// a cancel issued outside a workflow hands it on from the runner.
import {
  type AgentStreamEvent,
  type ModelProvider,
  type ModelTurnArgs,
  type ModelTurnResult,
  decodeStreamEvent,
} from '@dudousxd/nestjs-agent-core';
import { InMemoryAgentStore } from '@dudousxd/nestjs-agent-testing';
import { DurableModule } from '@dudousxd/nestjs-durable';
import { InMemoryStateStore, WorkflowEngine } from '@dudousxd/nestjs-durable-core';
import { EventEmitterTransport } from '@dudousxd/nestjs-durable-transport-event-emitter';
import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { AgentModule } from '../agent.module.js';
import { AgentService, type ChatSendResult } from '../agent.service.js';
import { Agent } from '../decorator/agent.decorator.js';
import { HeaderActorResolver } from '../resolver/header-actor-resolver.js';
import { AgentDurableModule } from './agent-durable.module.js';

const ACTOR = { id: 'u1' };

@Agent({ name: 'default', systemPrompt: 'durable queue test agent', model: 'fake-1' })
@Injectable()
class DefaultAgent {}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** Answers `re: <message>`; a message can be held mid-turn, or made to fail. */
class ScriptedModel implements ModelProvider {
  readonly seen: string[] = [];
  readonly failing = new Set<string>();
  private readonly holds = new Map<string, ReturnType<typeof deferred>>();
  private readonly entered = new Map<string, ReturnType<typeof deferred>>();

  hold(message: string): void {
    this.holds.set(message, deferred());
  }

  release(message: string): void {
    this.holds.get(message)?.resolve();
  }

  reached(message: string): Promise<void> {
    return this.enteredFor(message).promise;
  }

  private enteredFor(message: string) {
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

async function buildApp() {
  const store = new InMemoryAgentStore();
  const model = new ScriptedModel();
  const moduleRef = await Test.createTestingModule({
    imports: [
      DurableModule.forRoot({
        store: new InMemoryStateStore(),
        transport: new EventEmitterTransport(new EventEmitter2()),
      }),
      AgentModule.forRoot({
        model,
        store,
        actorResolver: new HeaderActorResolver(),
        durable: true,
        defaultAgent: 'default',
      }),
      AgentDurableModule,
    ],
    providers: [DefaultAgent],
  }).compile();
  await moduleRef.init();
  const thread = await store.createThread({ actor: ACTOR });
  return {
    moduleRef,
    store,
    model,
    threadId: thread.id,
    service: moduleRef.get(AgentService),
    engine: moduleRef.get(WorkflowEngine),
  };
}

async function drain(service: AgentService, runId: string) {
  const frames: AgentStreamEvent[] = [];
  let failure: unknown;
  try {
    for await (const chunk of service.subscribe(runId)) {
      for (const line of new TextDecoder().decode(chunk).split('\n')) {
        const event = line.length > 0 ? decodeStreamEvent(line) : null;
        if (event !== null) frames.push(event);
      }
    }
  } catch (error) {
    failure = error;
  }
  return { frames, failure };
}

function started(result: ChatSendResult): string {
  if (result.queued === true) throw new Error('expected the send to start a turn');
  return result.runId;
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out; last value: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('the chat message queue under the durable runner', () => {
  it('starts the next queued message as the running turn completes', async () => {
    const app = await buildApp();
    try {
      app.model.hold('first');
      const firstRun = started(
        await app.service.send({ actor: ACTOR, threadId: app.threadId, message: 'first' }),
      );
      const streamed = drain(app.service, firstRun);
      await app.model.reached('first');

      const queued = await app.service.send({
        actor: ACTOR,
        threadId: app.threadId,
        message: 'second',
      });
      expect(queued).toMatchObject({ queued: true, position: 0 });
      const messageId = (queued as { messageId: string }).messageId;

      app.model.release('first');
      const { frames, failure } = await streamed;
      expect(failure).toBeUndefined();
      expect(frames.filter((frame) => frame.kind === 'queue').at(-1)).toEqual({
        kind: 'queue',
        queue: { items: [], paused: null },
        started: { messageId, runId: messageId },
      });

      // The queued message runs as a durable run of its own, under its own id.
      const next = await app.engine.waitForRun(messageId, { timeoutMs: 5000, until: 'terminal' });
      expect(next.status).toBe('completed');
      const thread = await until(
        () => app.store.getThread(app.threadId),
        (value) => value?.activeRunId === undefined && (value?.messages.length ?? 0) >= 4,
      );
      expect(thread?.messages.map((message) => `${message.role}: ${message.content}`)).toEqual([
        'user: first',
        'assistant: re: first',
        'user: second',
        'assistant: re: second',
      ]);
      expect(app.model.seen).toEqual(['first', 'second']);
    } finally {
      app.model.release('first');
      await app.moduleRef.close();
    }
  });

  it('pauses the queue behind a failed turn', async () => {
    const app = await buildApp();
    try {
      app.model.hold('first');
      app.model.failing.add('first');
      const firstRun = started(
        await app.service.send({ actor: ACTOR, threadId: app.threadId, message: 'first' }),
      );
      const streamed = drain(app.service, firstRun);
      await app.model.reached('first');
      await app.service.send({ actor: ACTOR, threadId: app.threadId, message: 'second' });

      app.model.release('first');
      const { frames, failure } = await streamed;
      expect(failure).toBeDefined();
      expect(frames.at(-1)).toMatchObject({
        kind: 'queue',
        queue: { items: [{ content: 'second' }], paused: { reason: 'run_failed' } },
      });
      await app.engine.waitForRun(firstRun, { timeoutMs: 5000, until: 'terminal' });
      expect(await app.store.activeRunForThread(app.threadId)).toBeNull();
      // (The dispatched model step retries the failing call; the queued message is never asked.)
      expect(app.model.seen).not.toContain('second');
    } finally {
      app.model.release('first');
      await app.moduleRef.close();
    }
  });

  it('an interrupt cancels the running turn from outside and starts next', async () => {
    const app = await buildApp();
    try {
      app.model.hold('first');
      const firstRun = started(
        await app.service.send({ actor: ACTOR, threadId: app.threadId, message: 'first' }),
      );
      const streamed = drain(app.service, firstRun);
      await app.model.reached('first');

      const interrupt = await app.service.send({
        actor: ACTOR,
        threadId: app.threadId,
        message: 'now',
        mode: 'interrupt',
      });
      expect(interrupt).toMatchObject({ queued: true, interrupting: firstRun });
      const messageId = (interrupt as { messageId: string }).messageId;

      const { frames } = await streamed;
      expect(frames.slice(-2)).toEqual([
        {
          kind: 'queue',
          queue: { items: [], paused: null },
          started: { messageId, runId: messageId },
        },
        { kind: 'cancelled' },
      ]);
      app.model.release('first');
      const next = await app.engine.waitForRun(messageId, { timeoutMs: 5000, until: 'terminal' });
      expect(next.status).toBe('completed');
      await until(
        async () => app.model.seen,
        (seen) => seen.includes('now'),
      );
      // The cancelled turn settling afterwards must not take the thread back from the new one.
      await app.engine.waitForRun(firstRun, { timeoutMs: 5000, until: 'terminal' });
      const thread = await until(
        () => app.store.getThread(app.threadId),
        (value) => value?.messages.some((message) => message.content === 're: now') === true,
      );
      expect(thread?.messages.slice(-2).map((message) => message.content)).toEqual([
        'now',
        're: now',
      ]);
    } finally {
      app.model.release('first');
      await app.moduleRef.close();
    }
  });
});
