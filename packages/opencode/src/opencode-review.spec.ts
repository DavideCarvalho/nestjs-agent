import 'reflect-metadata';
import {
  type Actor,
  type AgentRunInput,
  RUN_FAILED_MESSAGE,
  exposeStreamErrorDetails,
} from '@dudousxd/nestjs-agent-core';
import { DurableModule } from '@dudousxd/nestjs-durable';
import { InMemoryStateStore } from '@dudousxd/nestjs-durable-core';
import { EventEmitterTransport } from '@dudousxd/nestjs-durable-transport-event-emitter';
import { Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openCodeDurable } from './durable/index.js';
import { openCode } from './engine.js';
import type { FakeScript } from './testing/fake-opencode.js';
import { type Harness, bootEngine, frames, framesUntil, textOf } from './testing/harness.js';
import { OpenCodeReplyMismatchError } from './turn.js';
import { OpenCodeTurns } from './turns.js';

const actor: Actor = { id: 'u1', roles: ['ADMIN'] };

const askToSend: FakeScript = async (t) => {
  t.emit('session.text.delta', { delta: 'Sending.' });
  t.emit('permission.asked', { id: 'per_1', action: 'company.gmail__send_email' });
  const reply = await t.next('permission.reply');
  t.emit('session.text.delta', { delta: reply.args.decision === 'once' ? ' Sent.' : ' Not sent.' });
  t.succeed();
};

function durableImports() {
  return [
    DurableModule.forRoot({
      store: new InMemoryStateStore(),
      transport: new EventEmitterTransport(new EventEmitter2()),
    }),
  ];
}

describe('openCode engine: a form answer sent to an approval', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.app.close();
    h = undefined;
  });

  for (const kind of ['inline', 'durable'] as const) {
    it(`is refused, and the approval keeps waiting (${kind})`, async () => {
      h = await bootEngine({
        engine: (host) => (kind === 'inline' ? openCode({ host }) : openCodeDurable({ host })),
        script: askToSend,
        ...(kind === 'durable' ? { imports: durableImports() } : {}),
      });
      const { runId, threadId } = await h.service.chat({ actor, message: 'send it' });
      await framesUntil(h.service, runId, (f) => f.kind === 'approval-requested');

      const answering = h.service.answer(actor, 'per_1', { q1: ['yes'] });
      await expect(answering).rejects.toBeInstanceOf(OpenCodeReplyMismatchError);
      await expect(h.service.answer(actor, 'per_1', { q1: ['yes'] })).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining('waiting for an approve/reject, not for answers'),
      });
      await expect(h.service.skip(actor, 'per_1')).rejects.toMatchObject({ status: 409 });
      // Nobody rejected anything: OpenCode was not told no, and the card still waits.
      expect(h.fake.callsOf('permission.reply')).toEqual([]);
      expect((await h.store.toolCallApproval?.('per_1'))?.status).toBe('pending_approval');

      await h.service.approve(actor, 'per_1');
      const fs = await frames(h.service, runId);
      expect(textOf(fs)).toContain('Sent.');
      expect(h.fake.callsOf('permission.reply')[0]?.args).toMatchObject({ decision: 'once' });
      expect(fs).toContainEqual(
        expect.objectContaining({ kind: 'approval-settled', id: 'per_1', status: 'approved' }),
      );
      const call = (await h.store.getThread(threadId))?.messages
        .flatMap((m) => m.toolResults ?? [])
        .find((r) => r.id === 'per_1');
      expect(call?.output).toEqual({ approved: true });
    });
  }
});

describe("openCode engine: OpenCode's own error text", () => {
  let h: Harness | undefined;
  afterEach(async () => {
    exposeStreamErrorDetails(undefined);
    vi.restoreAllMocks();
    await h?.app.close();
    h = undefined;
  });

  const failing: FakeScript = async (t) => {
    t.emit('session.execution.failed', {
      error: { message: 'upstream 500 from https://10.0.0.7/v1 (key sk-live-…)' },
    });
  };

  it('reaches the person as the generic message in production, and the log in full', async () => {
    exposeStreamErrorDetails(false);
    const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    h = await bootEngine({ engine: (host) => openCode({ host }), script: failing });
    const { runId } = await h.service.chat({ actor, message: 'hi' });
    const failure = await frames(h.service, runId).catch((error: unknown) => error as Error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(RUN_FAILED_MESSAGE);
    expect((failure as Error).message).not.toContain('10.0.0.7');
    expect(logged.mock.calls.map((c) => String(c[0])).join('\n')).toContain('10.0.0.7');
  });

  it('rides the stream outside production, as the library does with any provider error', async () => {
    exposeStreamErrorDetails(true);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    h = await bootEngine({ engine: (host) => openCode({ host }), script: failing });
    const { runId } = await h.service.chat({ actor, message: 'hi' });
    await expect(frames(h.service, runId)).rejects.toThrow('10.0.0.7');
  });

  it('hides a refused prompt the same way', async () => {
    exposeStreamErrorDetails(false);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    h = await bootEngine({ engine: (host) => openCode({ host }) });
    h.fake.session.prompt = async () => {
      throw new Error('ECONNREFUSED 10.0.0.7:4096');
    };
    const { runId } = await h.service.chat({ actor, message: 'hi' });
    const failure = await frames(h.service, runId).catch((error: unknown) => error as Error);
    expect((failure as Error).message).toContain(RUN_FAILED_MESSAGE);
    expect((failure as Error).message).not.toContain('ECONNREFUSED');
  });
});

describe('openCode engine: an event stream slow to open', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.app.close();
    h = undefined;
  });

  it('loses nothing OpenCode says before the stream reached the server', async () => {
    h = await bootEngine({ engine: (host) => openCode({ host }) });
    // The subscription takes a while to reach the server; OpenCode answers the prompt at once.
    h.fake.connectDelayMs = 60;
    const { runId, threadId } = await h.service.chat({ actor, message: 'hello' });
    const fs = await frames(h.service, runId);
    expect(textOf(fs)).toBe('echo: hello');
    expect((await h.store.getThread(threadId))?.messages.map((m) => m.content)).toEqual([
      'hello',
      'echo: hello',
    ]);
  });
});

describe('openCode engine: begin, run again after a crash', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.app.close();
    h = undefined;
  });

  it('writes the run’s user message once, and keeps the one session', async () => {
    h = await bootEngine({ engine: (host) => openCode({ host }) });
    const earlier = await h.service.chat({ actor, message: 'first' });
    await frames(h.service, earlier.runId);
    const turns = h.app.get(OpenCodeTurns);
    const input: AgentRunInput = { threadId: earlier.threadId, actor, userText: 'second' };

    // A durable `begin` whose checkpoint was never written runs again, in full.
    const first = await turns.begin('run-2', input);
    const again = await turns.begin('run-2', input);
    expect(again).toEqual(first);

    const messages = (await h.store.getThread(earlier.threadId))?.messages ?? [];
    expect(messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'first'],
      ['assistant', 'echo: first'],
      ['user', 'second'],
    ]);
    expect(h.fake.callsOf('session.create')).toHaveLength(1);
    // A different run is a different message.
    await turns.begin('run-3', { ...input, userText: 'third' });
    expect((await h.store.getThread(earlier.threadId))?.messages.at(-1)?.content).toBe('third');
  });

  it('tells a new session the history without the run’s own message', async () => {
    h = await bootEngine({ engine: (host) => openCode({ host }) });
    const earlier = await h.service.chat({ actor, message: 'first' });
    await frames(h.service, earlier.runId);
    const turns = h.app.get(OpenCodeTurns);
    const input: AgentRunInput = { threadId: earlier.threadId, actor, userText: 'second' };
    await turns.begin('run-2', input);
    // The server restarted between the two attempts: the second one opens a session.
    h.host.bootId = 'boot-2';
    await turns.begin('run-2', input);
    const history = h.fake
      .callsOf('session.instructions.entry.put')
      .filter((c) => c.args.key === 'aviary.history')
      .at(-1)?.args.value as string;
    expect(history).toContain('User: first');
    expect(history).not.toContain('User: second');
  });
});
