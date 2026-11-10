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

  it('stops a turn that goes past its compactions', async () => {
    const r = recorder();
    h = await boot({
      limits: { compactions: 1 },
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
    // The person approves, but the turn is being stopped: the action is refused, never run.
    await h.service.approve(actor, 'per_1');
    const { fs, error } = await stopped(h, runId);
    expect(h.fake.callsOf('permission.reply').map((c) => c.args.decision)).toEqual(['reject']);
    expect((await h.store.toolCallApproval?.('per_1'))?.status).toBe('rejected');

    expect(error).toMatchObject({ name: 'AgentStreamError', code: 'opencode_stopped' });
    expect(h.fake.callsOf('session.interrupt')).toHaveLength(1);
    expect(r.of('onStop')).toEqual([
      expect.objectContaining({ turnId: runId, reason: 'credentials-revoked' }),
    ]);
  });
});

describe('a turn parked on a person', () => {
  let h: Harness | undefined;
  let go: () => void = () => undefined;
  afterEach(async () => {
    go();
    await h?.app.close();
    h = undefined;
  });

  /** Asks for `per_1`, then (once let go) runs a parallel `read` tool while the ask waits. */
  function parallelRead(after?: (t: Parameters<FakeScript>[0]) => void): FakeScript {
    const gate = new Promise<void>((resolve) => {
      go = resolve;
    });
    return async (t) => {
      t.emit('session.step.started');
      t.emit('permission.asked', { id: 'per_1', action: 'company.gmail__send_email' });
      await gate;
      t.emit('session.tool.input.started', { id: 'call_read', name: 'read' });
      t.emit('session.tool.called', { id: 'call_read', name: 'read', input: { path: 'a.md' } });
      t.emit('session.tool.success', { id: 'call_read' });
      after?.(t);
      const reply = await t.next('permission.reply');
      t.emit('session.text.delta', { delta: reply.args.decision === 'once' ? 'Sent.' : 'No.' });
      t.succeed();
    };
  }

  const readOutput = (f: AgentStreamEvent) => f.kind === 'tool-output' && f.id === 'call_read';

  it("keeps following the step's other tools, with no options", async () => {
    h = await boot({ script: parallelRead() });
    const turns = h.app.get(OpenCodeTurns);
    const { runId, threadId } = await h.service.chat({ actor, message: 'send it' });
    await framesUntil(h.service, runId, (f) => f.kind === 'approval-requested');
    go();
    await framesUntil(h.service, runId, readOutput);
    expect(turns.liveRuns()).toEqual([runId]);

    await h.service.approve(actor, 'per_1');
    const fs = await frames(h.service, runId);
    expect(textOf(fs)).toBe('Sent.');
    expect(h.fake.callsOf('permission.reply').map((c) => c.args.decision)).toEqual(['once']);
    // The parallel tool is streamed and persisted as it always was.
    const ofRead = fs.filter((f) => 'id' in f && f.id === 'call_read').map((f) => f.kind);
    expect(ofRead).toEqual(['tool-input-start', 'tool-input-available', 'tool-output']);
    const messages = (await h.store.getThread(threadId))?.messages ?? [];
    const last = messages.at(-1);
    expect(last?.toolCalls?.map((c) => [c.id, c.name])).toEqual([['call_read', 'read']]);
    expect(last?.toolResults?.map((r) => [r.id, r.output])).toEqual([['call_read', { ok: true }]]);
  });

  it("keeps following the step's other tools with limits and hooks, and a stop still refuses the ask", async () => {
    const r = recorder();
    h = await boot({ limits: { steps: 5 }, hooks: r.hooks, script: parallelRead() });
    const turns = h.app.get(OpenCodeTurns);
    const { runId } = await h.service.chat({ actor, message: 'send it' });
    await framesUntil(h.service, runId, (f) => f.kind === 'approval-requested');
    go();
    await framesUntil(h.service, runId, readOutput);
    expect(turns.liveRuns()).toEqual([runId]);
    expect(await turns.stopTurn(runId, 'credentials-revoked')).toBe('pending');

    await h.service.approve(actor, 'per_1');
    await stopped(h, runId);
    expect(h.fake.callsOf('permission.reply').map((c) => c.args.decision)).toEqual(['reject']);
    expect(r.of('onTurnStart')).toHaveLength(1);
    // The refused ask ends the execution at once here, so the stop lands as it settles.
    expect(r.of('onTurnEnd')).toEqual([
      {
        turnId: runId,
        status: 'succeeded',
        stop: expect.objectContaining({ reason: 'credentials-revoked' }),
      },
    ]);
    expect(r.of('onStop')).toHaveLength(1);
  });

  it('lets the turn go when a new round starts without this process', async () => {
    const r = recorder();
    h = await boot({ hooks: r.hooks, script: parallelRead() });
    const turns = h.app.get(OpenCodeTurns);
    const { runId } = await h.service.chat({ actor, message: 'send it' });
    await framesUntil(h.service, runId, (f) => f.kind === 'approval-requested');
    // Another worker answered the ask and OpenCode started the next round.
    h.fake.emit({ type: 'session.step.started', data: { sessionID: 'ses_1' } });
    await eventually(() => r.of('onTurnEnd').length > 0, 'the turn is let go');
    expect(r.of('onTurnEnd')).toEqual([{ turnId: runId, status: 'released' }]);
    expect(turns.liveRuns()).toEqual([]);
    expect(await turns.stopTurn(runId, 'wall-clock')).toBe('ignored');
  });

  it('keeps a turn whose execution ended while its ask is still open, and starts it once', async () => {
    const r = recorder();
    h = await boot({
      hooks: r.hooks,
      script: parallelRead((t) =>
        t.emit('session.execution.failed', { error: { message: 'gone' } }),
      ),
    });
    const turns = h.app.get(OpenCodeTurns);
    const { runId } = await h.service.chat({ actor, message: 'send it' });
    await framesUntil(h.service, runId, (f) => f.kind === 'approval-requested');
    go();
    await framesUntil(h.service, runId, readOutput);
    // Past the first rechecks of the store: the ask is still open, so the turn stays.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(turns.liveRuns()).toEqual([runId]);
    expect(r.of('onTurnEnd')).toEqual([]);

    await h.service.approve(actor, 'per_1');
    await stopped(h, runId);
    expect(r.of('onTurnStart')).toHaveLength(1);
    expect(r.of('onTurnEnd')).toEqual([{ turnId: runId, status: 'failed' }]);
  });

  it('opens and prompts no new session for a stopping turn whose server restarted', async () => {
    const r = recorder();
    h = await boot({ hooks: r.hooks, script: parallelRead() });
    const turns = h.app.get(OpenCodeTurns);
    const { runId } = await h.service.chat({ actor, message: 'send it' });
    await framesUntil(h.service, runId, (f) => f.kind === 'approval-requested');
    expect(await turns.stopTurn(runId, 'credentials-revoked')).toBe('pending');
    h.host.bootId = 'boot-2';
    await h.service.approve(actor, 'per_1');
    const { error } = await stopped(h, runId);

    expect(error).toMatchObject({ code: 'opencode_stopped' });
    expect(h.fake.callsOf('session.create')).toHaveLength(1);
    expect(h.fake.callsOf('session.prompt')).toHaveLength(1);
    expect(h.fake.callsOf('permission.reply')).toHaveLength(0);
    expect((await h.store.toolCallApproval?.('per_1'))?.status).toBe('rejected');
    expect(r.of('onStop')).toEqual([
      expect.objectContaining({ turnId: runId, reason: 'credentials-revoked' }),
    ]);
    expect(r.of('onTurnEnd')).toEqual([
      {
        turnId: runId,
        status: 'failed',
        stop: expect.objectContaining({ reason: 'credentials-revoked' }),
      },
    ]);
  });

  it('lets the turn go as cancelled when its execution was interrupted and nobody settles the ask', async () => {
    const r = recorder();
    h = await boot({ hooks: r.hooks, script: parallelRead() });
    const turns = h.app.get(OpenCodeTurns);
    turns.parkedRechecksMs = [150, 150];
    const { runId } = await h.service.chat({ actor, message: 'send it' });
    await framesUntil(h.service, runId, (f) => f.kind === 'approval-requested');
    // A cancel elsewhere interrupted the session, and never settled the ask.
    h.fake.emit({ type: 'session.execution.interrupted', data: { sessionID: 'ses_1' } });
    await eventually(
      () => r.of('onTurnEvent').some((e) => e.type === 'session.execution.interrupted'),
      'the turn hears its execution end',
    );
    // Still parked here: a stop is held for the ask, not reported as an answer settling.
    expect(await turns.stopTurn(runId, 'wall-clock')).toBe('pending');
    await eventually(() => r.of('onTurnEnd').length > 0, 'the turn is let go');

    expect(r.of('onTurnEnd')).toEqual([{ turnId: runId, status: 'interrupted' }]);
    expect(turns.liveRuns()).toEqual([]);
    expect(await turns.stopTurn(runId, 'wall-clock')).toBe('ignored');
    expect((await h.store.toolCallApproval?.('per_1'))?.status).toBe('pending_approval');
  });

  it('refuses a hook timeout that is not a positive number', async () => {
    const booted = await bootEngine({
      engine: (host) => openCode({ host, hookTimeoutMs: 0 }),
    }).then(
      (harness) => harness,
      (error: unknown) => error,
    );
    if (!(booted instanceof Error)) await (booted as Harness).app.close();
    expect(booted).toBeInstanceOf(Error);
    expect((booted as Error).message).toContain('hookTimeoutMs must be a positive number');
  });
});

describe('stopTurn guards the session the next turn may use', () => {
  let h: Harness | undefined;
  let release: () => void = () => undefined;
  afterEach(async () => {
    release();
    await h?.app.close();
    h = undefined;
  });

  /** A turn that runs until released, observed by this process (its `session.wait` is out). */
  async function running() {
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    h = await boot({
      script: async (t) => {
        t.emit('session.step.started');
        await held;
        t.emit('session.text.delta', { delta: `done ${t.text}` });
        t.succeed();
      },
    });
    const harness = h;
    const turns = harness.app.get(OpenCodeTurns);
    const turn = await harness.service.chat({ actor, message: 'a' });
    await eventually(() => harness.fake.callsOf('session.wait').length > 0, 'turn A observes');
    return { h: harness, turns, ...turn };
  }

  it("refuses to abort when the thread's store already runs another turn", async () => {
    const { h, turns, runId, threadId } = await running();
    // Turn A was cancelled elsewhere and turn B holds the thread; A's interrupted event is not in.
    await h.store.setActiveStream(threadId, 'turn-b');
    expect(await turns.stopTurn(runId, 'wall-clock')).toBe('ignored');
    expect(h.fake.callsOf('session.interrupt')).toHaveLength(0);
    // The same stop, once the store says A again, aborts: the refusal was the guard's.
    await h.store.setActiveStream(threadId, runId);
    expect(await turns.stopTurn(runId, 'wall-clock')).toBe('aborted');
    expect(h.fake.callsOf('session.interrupt')).toHaveLength(1);
  });

  it('refuses to abort a session another turn owns now', async () => {
    const { h, turns, runId, threadId } = await running();
    // Turn B starts on the reused session in this process while A's state is still here.
    const session = { sessionId: 'ses_1', serverKey: 'tenant-1', bootId: 'boot-1' };
    await turns.prompt('turn-b', { threadId, actor, userText: 'b' }, session);
    expect(await turns.stopTurn(runId, 'wall-clock')).toBe('ignored');
    expect(h.fake.callsOf('session.interrupt')).toHaveLength(0);
    // B's own stop is B's to make: it is held until B observes.
    expect(await turns.stopTurn('turn-b', 'wall-clock')).toBe('pending');
    expect(h.fake.callsOf('session.interrupt')).toHaveLength(0);
  });

  it("aborts nothing when the thread's store cannot be read", async () => {
    const { h, turns, runId } = await running();
    const read = h.store.activeRunForThread.bind(h.store);
    h.store.activeRunForThread = async () => {
      throw new Error('store down');
    };
    expect(await turns.stopTurn(runId, 'wall-clock')).toBe('unconfirmed');
    expect(h.fake.callsOf('session.interrupt')).toHaveLength(0);
    h.store.activeRunForThread = read;
    expect(await turns.stopTurn(runId, 'wall-clock')).toBe('aborted');
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
