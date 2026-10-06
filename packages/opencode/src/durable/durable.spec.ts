import 'reflect-metadata';
import type { Actor } from '@dudousxd/nestjs-agent-core';
import { DurableModule } from '@dudousxd/nestjs-durable';
import { InMemoryStateStore, WorkflowEngine } from '@dudousxd/nestjs-durable-core';
import { EventEmitterTransport } from '@dudousxd/nestjs-durable-transport-event-emitter';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { afterEach, describe, expect, it } from 'vitest';
import type { FakeScript } from '../testing/fake-opencode.js';
import { type Harness, bootEngine, frames, framesUntil, textOf } from '../testing/harness.js';
import { OpenCodeTurns } from '../turns.js';
import { openCodeDurable } from './index.js';

const actor: Actor = { id: 'u1', roles: ['ADMIN'] };

const askToSend: FakeScript = async (t) => {
  if (t.text.includes('approved the action')) {
    // A fresh session after OpenCode restarted, told what the person decided.
    t.emit('session.text.delta', { delta: 'Sent after the restart.' });
    t.succeed();
    return;
  }
  t.emit('session.text.delta', { delta: 'Sending.' });
  t.emit('permission.asked', { id: 'per_1', action: 'company.gmail__send_email' });
  const reply = await t.next('permission.reply');
  t.emit('session.text.delta', { delta: reply.args.decision === 'once' ? 'Sent.' : 'Not sent.' });
  t.succeed();
};

function durable(script: FakeScript = askToSend) {
  return bootEngine({
    engine: (host) => openCodeDurable({ host }),
    script,
    imports: [
      DurableModule.forRoot({
        store: new InMemoryStateStore(),
        transport: new EventEmitterTransport(new EventEmitter2()),
      }),
    ],
  });
}

async function terminal(h: Harness, runId: string) {
  return h.app.get(WorkflowEngine).waitForRun(runId, { timeoutMs: 5000, until: 'terminal' });
}

describe('openCodeDurable', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.app.close();
    h = undefined;
  });

  it('runs a turn as a durable workflow', async () => {
    h = await durable(undefined);
    h.fake.script = async (t) => {
      t.emit('session.text.delta', { delta: `echo: ${t.text}` });
      t.succeed();
    };
    const { runId, threadId } = await h.service.chat({ actor, message: 'hello' });
    const fs = await frames(h.service, runId);
    expect(textOf(fs)).toBe('echo: hello');
    expect((await terminal(h, runId)).status).toBe('completed');
    expect((await h.store.getThread(threadId))?.messages.map((m) => m.content)).toEqual([
      'hello',
      'echo: hello',
    ]);
  });

  it('waits on a durable signal for the approval and replies to OpenCode', async () => {
    h = await durable();
    const { runId } = await h.service.chat({ actor, message: 'send it' });
    await framesUntil(h.service, runId, (f) => f.kind === 'approval-requested');
    await h.service.approve(actor, 'per_1');
    const fs = await frames(h.service, runId);
    expect(textOf(fs)).toContain('Sent.');
    expect(h.fake.callsOf('permission.reply')[0]?.args).toMatchObject({ decision: 'once' });
    expect((await terminal(h, runId)).status).toBe('completed');
  });

  it('replies from a process that never followed the turn (an API restart while parked)', async () => {
    h = await durable();
    const { runId } = await h.service.chat({ actor, message: 'send it' });
    await framesUntil(h.service, runId, (f) => f.kind === 'approval-requested');
    // What a restart leaves: no live turn, no listener, only the journal and the store.
    h.app.get(OpenCodeTurns).drop(runId);
    await h.service.approve(actor, 'per_1');
    const fs = await frames(h.service, runId);
    expect(textOf(fs)).toContain('Sent.');
    expect((await terminal(h, runId)).status).toBe('completed');
  });

  it('opens a new session told the decision when OpenCode restarted while parked', async () => {
    h = await durable();
    const { runId, threadId } = await h.service.chat({ actor, message: 'send it' });
    await framesUntil(h.service, runId, (f) => f.kind === 'approval-requested');
    h.host.bootId = 'boot-2';
    await h.service.approve(actor, 'per_1');
    const fs = await frames(h.service, runId);

    expect(h.fake.callsOf('permission.reply')).toHaveLength(0);
    expect(h.fake.callsOf('session.create')).toHaveLength(2);
    expect(String(h.fake.callsOf('session.prompt')[1]?.args.text)).toContain(
      'approved the action company.gmail__send_email',
    );
    expect(textOf(fs)).toContain('Sent after the restart.');
    expect((await terminal(h, runId)).status).toBe('completed');
    const messages = (await h.store.getThread(threadId))?.messages ?? [];
    expect(messages.at(-1)?.content).toBe('Sent after the restart.');
  });

  it('cancels a run parked on a person', async () => {
    h = await durable();
    const { runId } = await h.service.chat({ actor, message: 'send it' });
    await framesUntil(h.service, runId, (f) => f.kind === 'approval-requested');
    await h.service.cancel(actor, runId);
    const fs = await frames(h.service, runId);
    expect(fs.at(-1)).toEqual({ kind: 'cancelled' });
    expect(h.fake.callsOf('session.interrupt')).toHaveLength(1);
  });
});
