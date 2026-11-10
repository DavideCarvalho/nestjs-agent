import 'reflect-metadata';
import type { Actor, AgentStreamEvent } from '@dudousxd/nestjs-agent-core';
import { DurableModule } from '@dudousxd/nestjs-durable';
import { InMemoryStateStore, WorkflowEngine } from '@dudousxd/nestjs-durable-core';
import { EventEmitterTransport } from '@dudousxd/nestjs-durable-transport-event-emitter';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { afterEach, describe, expect, it } from 'vitest';
import { openCode } from '../engine.js';
import type { OpenCodeRunResult } from '../host.js';
import type { FakeScript } from '../testing/fake-opencode.js';
import {
  type Harness,
  bootEngine,
  eventually,
  frames,
  framesUntil,
  textOf,
} from '../testing/harness.js';
import type { OpenCodeTurnHooks, OpenCodeTurnLimits } from '../turn-limits.js';
import { OpenCodeTurns } from '../turns.js';
import { openCodeDurable } from './index.js';

const actor: Actor = { id: 'u1', roles: ['ADMIN'] };

type Logged = { hook: keyof OpenCodeTurnHooks; event: Record<string, unknown> };

function recorder() {
  const log: Logged[] = [];
  const push = (hook: keyof OpenCodeTurnHooks) => (event: object) => {
    log.push({ hook, event: event as Record<string, unknown> });
  };
  const hooks: OpenCodeTurnHooks = {
    onTurnStart: push('onTurnStart'),
    onTurnEvent: push('onTurnEvent'),
    onStop: push('onStop'),
    onTurnEnd: push('onTurnEnd'),
  };
  const of = (hook: keyof OpenCodeTurnHooks) =>
    log.filter((l) => l.hook === hook).map((l) => l.event);
  return { log, hooks, of };
}

function boot(args: {
  script: FakeScript;
  limits?: OpenCodeTurnLimits;
  hooks?: OpenCodeTurnHooks;
  settled?: OpenCodeRunResult[];
}) {
  return bootEngine({
    engine: (host) =>
      openCodeDurable({
        host: Object.assign(host, {
          onSettled: async (result: OpenCodeRunResult) => {
            args.settled?.push(result);
          },
        }),
        ...(args.limits !== undefined ? { limits: args.limits } : {}),
        ...args.hooks,
      }),
    script: args.script,
    imports: [
      DurableModule.forRoot({
        store: new InMemoryStateStore(),
        transport: new EventEmitterTransport(new EventEmitter2()),
      }),
    ],
  });
}

async function result(h: Harness, runId: string) {
  return h.app.get(WorkflowEngine).waitForRun(runId, { timeoutMs: 5000, until: 'terminal' });
}

/** The frames of a run that ends failed, and the failure its stream ends with. */
async function stopped(h: Harness, runId: string) {
  const fs: AgentStreamEvent[] = [];
  let error: unknown;
  try {
    await framesUntil(h.service, runId, (f) => {
      fs.push(f);
      return false;
    });
  } catch (caught) {
    error = caught;
  }
  return { fs, error };
}

/** Keeps the session busy until the engine aborts it (the fake answers `interrupted`). */
const untilAborted = (t: Parameters<FakeScript>[0]) => t.next('session.interrupt');

describe('openCodeDurable turn limits', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.app.close();
    h = undefined;
  });

  it('stops a turn that goes past its steps, aborting its session', async () => {
    const r = recorder();
    const settled: OpenCodeRunResult[] = [];
    h = await boot({
      limits: { steps: 1 },
      hooks: r.hooks,
      settled,
      script: async (t) => {
        t.emit('session.step.started');
        t.emit('session.text.delta', { delta: 'Working.' });
        t.emit('session.step.ended', { tokens: { input: 1, output: 1 } });
        t.emit('session.step.started');
        await untilAborted(t);
      },
    });
    const { runId, threadId } = await h.service.chat({ actor, message: 'go' });
    const { fs, error } = await stopped(h, runId);

    expect(textOf(fs)).toBe('Working.');
    expect(error).toMatchObject({ name: 'AgentStreamError', code: 'opencode_stopped' });
    expect(h.fake.callsOf('session.interrupt')).toEqual([
      { method: 'session.interrupt', args: { sessionID: 'ses_1' } },
    ]);
    expect((await result(h, runId)).output).toEqual({ outcome: 'failed', stop: 'steps' });
    expect(r.of('onStop')).toEqual([
      { turnId: runId, reason: 'steps', counts: expect.objectContaining({ steps: 2 }) },
    ]);
    expect(r.of('onTurnEnd')).toEqual([
      { turnId: runId, status: 'failed', stop: expect.objectContaining({ reason: 'steps' }) },
    ]);
    expect(settled[0]?.outcome).toMatchObject({ status: 'failed', stop: { reason: 'steps' } });
    // What was said before the stop is kept.
    const messages = (await h.store.getThread(threadId))?.messages ?? [];
    expect(messages.map((m) => m.content)).toEqual(['go', 'Working.']);
  });

  it('stops a turn when it reaches its compactions', async () => {
    const r = recorder();
    h = await boot({
      limits: { compactions: 2 },
      hooks: r.hooks,
      script: async (t) => {
        t.emit('session.step.started');
        t.emit('session.compaction.started');
        t.emit('session.compaction.ended');
        t.emit('session.step.started');
        t.emit('session.compaction.started');
        await untilAborted(t);
      },
    });
    const { runId } = await h.service.chat({ actor, message: 'go' });
    const { fs, error } = await stopped(h, runId);

    expect(error).toMatchObject({ name: 'AgentStreamError', code: 'opencode_stopped' });
    expect(h.fake.callsOf('session.interrupt')).toHaveLength(1);
    expect((await result(h, runId)).output).toEqual({ outcome: 'failed', stop: 'compactions' });
    expect(r.of('onStop')).toEqual([
      {
        turnId: runId,
        reason: 'compactions',
        counts: expect.objectContaining({ steps: 2, compactions: 2 }),
      },
    ]);
  });

  it('stops a turn that runs longer than its wall clock', async () => {
    const r = recorder();
    h = await boot({
      limits: { wallClockMs: 80 },
      hooks: r.hooks,
      script: async (t) => {
        t.emit('session.step.started');
        t.emit('session.text.delta', { delta: 'Thinking for a long time' });
        await untilAborted(t);
      },
    });
    const { runId } = await h.service.chat({ actor, message: 'go' });
    const { fs, error } = await stopped(h, runId);

    expect(error).toMatchObject({ name: 'AgentStreamError', code: 'opencode_stopped' });
    expect((await result(h, runId)).output).toEqual({ outcome: 'failed', stop: 'wall-clock' });
    const [stop] = r.of('onStop');
    expect(stop).toMatchObject({ turnId: runId, reason: 'wall-clock' });
    expect((stop?.counts as { elapsedMs: number }).elapsedMs).toBeGreaterThanOrEqual(80);
  });

  it("counts only the turn's own session, and tells onTurnEvent only types and ids", async () => {
    const r = recorder();
    h = await boot({
      limits: { steps: 1, compactions: 1 },
      hooks: r.hooks,
      script: async (t) => {
        t.emit('session.step.started');
        // Another session on the same server (a subagent, another thread): not this turn's.
        for (let i = 0; i < 3; i += 1) {
          t.emit('session.step.started', { sessionID: 'ses_other' });
          t.emit('session.compaction.started', { sessionID: 'ses_other' });
        }
        t.emit('session.text.delta', { delta: 'secret answer' });
        t.emit('session.step.ended', { tokens: { input: 1, output: 1 } });
        t.succeed();
      },
    });
    const { runId } = await h.service.chat({ actor, message: 'go' });
    const fs = await frames(h.service, runId);

    expect(textOf(fs)).toBe('secret answer');
    expect(h.fake.callsOf('session.interrupt')).toHaveLength(0);
    expect((await result(h, runId)).output).toEqual({ outcome: 'succeeded' });
    expect(r.of('onStop')).toEqual([]);
    expect(r.of('onTurnEnd')).toEqual([{ turnId: runId, status: 'succeeded' }]);
    const events = r.of('onTurnEvent');
    expect(events.map((e) => e.type)).toEqual([
      'session.step.started',
      'session.text.delta',
      'session.step.ended',
      'session.execution.succeeded',
    ]);
    for (const event of events) {
      expect(event).toEqual({ turnId: runId, type: expect.any(String), sessionId: 'ses_1' });
    }
    expect(JSON.stringify(r.log)).not.toContain('secret answer');
  });

  it('keeps an answer that was settling when the stop landed, and reports the stop', async () => {
    const r = recorder();
    const settled: OpenCodeRunResult[] = [];
    h = await boot({
      limits: { steps: 1 },
      hooks: r.hooks,
      settled,
      script: async (t) => {
        t.emit('session.step.started');
        t.emit('session.text.delta', { delta: 'Done.' });
        t.emit('session.step.ended', { tokens: { input: 1, output: 1 } });
        t.succeed();
        // A round OpenCode reports after the execution ended: past the limit, but too late.
        t.emit('session.step.started');
      },
    });
    const { runId } = await h.service.chat({ actor, message: 'go' });
    const fs = await frames(h.service, runId);

    expect(textOf(fs)).toBe('Done.');
    expect(h.fake.callsOf('session.interrupt')).toHaveLength(0);
    expect((await result(h, runId)).output).toEqual({ outcome: 'succeeded', stop: 'steps' });
    expect(r.of('onStop')).toEqual([
      { turnId: runId, reason: 'steps', counts: expect.objectContaining({ steps: 2 }) },
    ]);
    expect(r.of('onTurnEnd')).toEqual([
      { turnId: runId, status: 'succeeded', stop: expect.objectContaining({ reason: 'steps' }) },
    ]);
    expect(settled[0]?.outcome).toMatchObject({ status: 'succeeded', stop: { reason: 'steps' } });
    expect(settled[0]?.text).toBe('Done.');
  });

  it("keeps the answer when the app's own stop races the execution's end", async () => {
    const ref: { turns?: OpenCodeTurns } = {};
    const answers: string[] = [];
    h = await boot({
      hooks: {
        onTurnEvent: ({ turnId, type }) => {
          if (type === 'session.execution.succeeded')
            void ref.turns?.stopTurn(turnId, 'credentials-revoked').then((r) => answers.push(r));
        },
      },
      script: async (t) => {
        t.emit('session.text.delta', { delta: 'Answer.' });
        t.succeed();
      },
    });
    ref.turns = h.app.get(OpenCodeTurns);
    const { runId } = await h.service.chat({ actor, message: 'go' });
    const fs = await frames(h.service, runId);

    expect(textOf(fs)).toBe('Answer.');
    expect(answers).toEqual(['settling']);
    expect(h.fake.callsOf('session.interrupt')).toHaveLength(0);
    expect((await result(h, runId)).output).toEqual({
      outcome: 'succeeded',
      stop: 'credentials-revoked',
    });
  });

  it("stops a running turn on the app's own reason", async () => {
    const r = recorder();
    h = await boot({
      hooks: r.hooks,
      script: async (t) => {
        t.emit('session.step.started');
        await untilAborted(t);
      },
    });
    const turns = h.app.get(OpenCodeTurns);
    const { runId } = await h.service.chat({ actor, message: 'go' });
    await eventually(() => r.of('onTurnEvent').length > 0, 'the turn runs');
    expect(await turns.stopTurn(runId, 'credentials-revoked')).toBe('aborted');
    const { fs, error } = await stopped(h, runId);

    expect(error).toMatchObject({ name: 'AgentStreamError', code: 'opencode_stopped' });
    expect((await result(h, runId)).output).toEqual({
      outcome: 'failed',
      stop: 'credentials-revoked',
    });
    // Once is enough: the turn is over.
    expect(await turns.stopTurn(runId, 'credentials-revoked')).toBe('ignored');
    expect(h.fake.callsOf('session.interrupt')).toHaveLength(1);
  });

  it("does not touch the thread's next turn with a stop for a turn that settled", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let running = false;
    h = await boot({
      limits: { wallClockMs: 60_000 },
      script: async (t) => {
        t.emit('session.step.started');
        if (t.text === 'second') {
          running = true;
          await held;
        }
        t.emit('session.text.delta', { delta: `answer to ${t.text}` });
        t.succeed();
      },
    });
    const turns = h.app.get(OpenCodeTurns);
    const first = await h.service.chat({ actor, message: 'first' });
    await frames(h.service, first.runId);
    await result(h, first.runId);

    const second = await h.service.chat({ actor, message: 'second', threadId: first.threadId });
    await eventually(() => running, 'the second turn runs');
    // A late stop of the first turn, on the session the second one now uses.
    expect(await turns.stopTurn(first.runId, 'wall-clock')).toBe('ignored');
    expect(h.fake.callsOf('session.interrupt')).toHaveLength(0);
    release();
    const fs = await frames(h.service, second.runId);

    expect(textOf(fs)).toBe('answer to second');
    expect((await result(h, second.runId)).output).toEqual({ outcome: 'succeeded' });
    expect(h.fake.callsOf('session.create')).toHaveLength(1);
  });

  it('holds a stop asked while the turn waits on a person until it observes again', async () => {
    const r = recorder();
    h = await boot({
      hooks: r.hooks,
      script: async (t) => {
        t.emit('session.step.started');
        t.emit('permission.asked', { id: 'per_1', action: 'company.gmail__send_email' });
        await t.next('permission.reply');
        t.emit('session.step.started');
        await untilAborted(t);
      },
    });
    const turns = h.app.get(OpenCodeTurns);
    const { runId } = await h.service.chat({ actor, message: 'send it' });
    await framesUntil(h.service, runId, (f) => f.kind === 'approval-requested');
    expect(await turns.stopTurn(runId, 'credentials-revoked')).toBe('pending');
    expect(h.fake.callsOf('session.interrupt')).toHaveLength(0);
    await h.service.approve(actor, 'per_1');
    const { fs, error } = await stopped(h, runId);

    expect(error).toMatchObject({ name: 'AgentStreamError', code: 'opencode_stopped' });
    expect(h.fake.callsOf('session.interrupt')).toHaveLength(1);
    expect(r.of('onStop')).toEqual([
      expect.objectContaining({ turnId: runId, reason: 'credentials-revoked' }),
    ]);
  });
});

describe('openCode (in memory) turn limits', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.app.close();
    h = undefined;
  });

  it('stops past its steps the same way', async () => {
    const stops: string[] = [];
    h = await bootEngine({
      engine: (host) =>
        openCode({ host, limits: { steps: 1 }, onStop: ({ reason }) => void stops.push(reason) }),
      script: async (t) => {
        t.emit('session.step.started');
        t.emit('session.step.started');
        await untilAborted(t);
      },
    });
    const { runId } = await h.service.chat({ actor, message: 'go' });
    const { fs, error } = await stopped(h, runId);
    expect(error).toMatchObject({ name: 'AgentStreamError', code: 'opencode_stopped' });
    expect(stops).toEqual(['steps']);
  });

  it('behaves as before without limits or hooks', async () => {
    h = await bootEngine({
      engine: (host) => openCode({ host }),
      script: async (t) => {
        for (let i = 0; i < 50; i += 1) t.emit('session.step.started');
        t.emit('session.compaction.started');
        t.emit('session.text.delta', { delta: 'fine' });
        t.succeed();
      },
    });
    const { runId } = await h.service.chat({ actor, message: 'go' });
    expect(textOf(await frames(h.service, runId))).toBe('fine');
    expect(h.fake.callsOf('session.interrupt')).toHaveLength(0);
  });
});
