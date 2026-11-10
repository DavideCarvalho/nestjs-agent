import 'reflect-metadata';
import { InProcessTokenStreamSink } from '@dudousxd/nestjs-agent';
import type { Actor } from '@dudousxd/nestjs-agent-core';
import { InMemoryAgentStore } from '@dudousxd/nestjs-agent-testing';
import { DurableModule } from '@dudousxd/nestjs-durable';
import { InMemoryStateStore, WorkflowEngine } from '@dudousxd/nestjs-durable-core';
import { EventEmitterTransport } from '@dudousxd/nestjs-durable-transport-event-emitter';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryOpenCodeSessionStore } from '../host.js';
import { FakeOpenCode, type FakeScript } from '../testing/fake-opencode.js';
import { type Harness, bootEngine, eventually } from '../testing/harness.js';
import type { OpenCodeTurnHooks } from '../turn-limits.js';
import { openCodeDurable } from './index.js';

const actor: Actor = { id: 'u1', roles: ['ADMIN'] };

type Logged = { process: string; hook: keyof OpenCodeTurnHooks; event: Record<string, unknown> };

/**
 * One deployment of several processes: one OpenCode server, one agent store, one stream sink, one
 * session store and one durable state store, each process with its own engine and its own hooks.
 */
function deployment(script: FakeScript) {
  const fake = new FakeOpenCode(script);
  const store = new InMemoryAgentStore();
  const sink = new InProcessTokenStreamSink();
  const sessions = new InMemoryOpenCodeSessionStore();
  const durableStore = new InMemoryStateStore();
  const emitter = new EventEmitter2();
  const log: Logged[] = [];
  const apps: Harness[] = [];

  const boot = async (process: string, durable: { drive?: boolean } = {}) => {
    const push = (hook: keyof OpenCodeTurnHooks) => (event: object) => {
      log.push({ process, hook, event: event as Record<string, unknown> });
    };
    const h = await bootEngine({
      fake,
      store,
      engine: (host) =>
        openCodeDurable({
          host,
          sessions,
          onTurnStart: push('onTurnStart'),
          onTurnEvent: push('onTurnEvent'),
          onStop: push('onStop'),
          onTurnEnd: push('onTurnEnd'),
        }),
      options: { sink },
      imports: [
        DurableModule.forRoot({
          store: durableStore,
          transport: new EventEmitterTransport(emitter),
          timerPollMs: 20,
          shutdownTimeoutMs: 100,
          ...durable,
        }),
      ],
    });
    apps.push(h);
    return h;
  };
  const by = (process: string, hook?: keyof OpenCodeTurnHooks) =>
    log.filter((l) => l.process === process && (hook === undefined || l.hook === hook));
  return { fake, store, log, apps, boot, by };
}

describe('openCodeDurable turn hooks', () => {
  let d: ReturnType<typeof deployment> | undefined;
  afterEach(async () => {
    for (const h of d?.apps ?? []) await h.app.close().catch(() => undefined);
    d = undefined;
  });

  it('fire on the worker that runs the steps, not on the process that started the turn', async () => {
    d = deployment(async (t) => {
      t.emit('session.step.started');
      t.emit('session.text.delta', { delta: 'from the worker' });
      t.emit('session.step.ended', { tokens: { input: 1, output: 1 } });
      t.succeed();
    });
    // The API admits the question and starts the run; it drives nothing.
    const api = await d.boot('api', { drive: false });
    const worker = await d.boot('worker');
    const { runId, threadId } = await api.service.chat({ actor, message: 'hello' });
    const run = await worker.app
      .get(WorkflowEngine)
      .waitForRun(runId, { timeoutMs: 5000, until: 'terminal' });

    expect(run.status).toBe('completed');
    expect(d.by('api')).toEqual([]);
    expect(d.by('worker', 'onTurnStart').map((l) => l.event)).toEqual([
      { turnId: runId, threadId, sessionId: 'ses_1', resumed: false },
    ]);
    expect(d.by('worker', 'onTurnEvent').map((l) => l.event.type)).toEqual([
      'session.step.started',
      'session.text.delta',
      'session.step.ended',
      'session.execution.succeeded',
    ]);
    expect(d.by('worker', 'onTurnEnd').map((l) => l.event)).toEqual([
      { turnId: runId, status: 'succeeded' },
    ]);
    const messages = (await d.store.getThread(threadId))?.messages ?? [];
    expect(messages.map((m) => m.content)).toEqual(['hello', 'from the worker']);
  });

  it('fire with resumed: true on the worker that takes the run over after a crash', async () => {
    d = deployment(async (t) => {
      t.emit('session.step.started');
      t.emit('permission.asked', { id: 'per_1', action: 'company.gmail__send_email' });
      const reply = await t.next('permission.reply');
      t.emit('session.text.delta', { delta: reply.args.decision === 'once' ? 'Sent.' : 'No.' });
      t.succeed();
    });
    const api = await d.boot('api', { drive: false });
    const first = await d.boot('first');
    const { runId, threadId } = await api.service.chat({ actor, message: 'send it' });
    await eventually(
      async () => (await d?.store.toolCallApproval?.('per_1')) != null,
      'the turn parks on the approval',
    );
    expect(d.by('first', 'onTurnStart').map((l) => l.event)).toEqual([
      { turnId: runId, threadId, sessionId: 'ses_1', resumed: false },
    ]);

    // The first worker dies while the turn waits; the decision reaches another one, which runs
    // the rest of the turn from the journal.
    await first.app.close();
    const second = await d.boot('second');
    await second.service.approve(actor, 'per_1');
    const run = await second.app
      .get(WorkflowEngine)
      .waitForRun(runId, { timeoutMs: 5000, until: 'terminal' });

    expect(run.status).toBe('completed');
    expect(d.fake.callsOf('permission.reply')[0]?.args).toMatchObject({ decision: 'once' });
    expect(d.by('api')).toEqual([]);
    expect(d.by('first', 'onTurnEnd')).toEqual([]);
    expect(d.by('second', 'onTurnStart').map((l) => l.event)).toEqual([
      { turnId: runId, threadId, sessionId: 'ses_1', resumed: true },
    ]);
    expect(d.by('second', 'onTurnEnd').map((l) => l.event)).toEqual([
      { turnId: runId, status: 'succeeded' },
    ]);
    expect(d.by('second', 'onTurnEvent').map((l) => l.event.type)).toContain(
      'session.execution.succeeded',
    );
  });
});
