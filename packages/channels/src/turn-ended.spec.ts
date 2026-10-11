import { InMemoryStateStore, WorkflowEngine } from '@dudousxd/nestjs-durable-core';
import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type FakeService,
  type ScriptedFrame,
  actor,
  channel,
  fakeAdapter,
  fakeService,
  inbound,
  request,
  texts,
  until,
} from './channels.spec-helper.js';
import type { ChannelWorkflowEngine } from './executor.js';
import type { ChannelOptions, ChannelTurnEnded } from './handler.js';
import type { ChannelCapabilities } from './types.js';

const never = <T = never>() => new Promise<T>(() => {});

const engineOver = (store: InMemoryStateStore) =>
  new WorkflowEngine({ store }) as unknown as ChannelWorkflowEngine & WorkflowEngine;

/** A handler whose `onTurnEnded` calls (and what happened around them) are recorded. */
function handler(
  service: FakeService,
  options: Partial<Omit<ChannelOptions, 'adapter'>> & { engine?: ChannelWorkflowEngine } = {},
  capabilities: Partial<ChannelCapabilities> = {},
) {
  const { adapter, outbox } = fakeAdapter(capabilities);
  const events: string[] = [];
  adapter.acknowledge = async (message) => {
    events.push(`ack:${message.text}`);
  };
  const send = adapter.send;
  adapter.send = async (conversation, message) => {
    events.push(`sent:${message.text}`);
    await send(conversation, message);
  };
  const ended: ChannelTurnEnded[] = [];
  const handle = channel(adapter, service, {
    onTurnEnded: (turn) => {
      ended.push(turn);
      events.push(`ended:${turn.outcome}`);
    },
    ...options,
  });
  const say = async (text: string, extra = {}) => {
    await handle.handle(request(inbound(text, extra)));
    await handle.drain();
  };
  return { handle, outbox, ended, events, say };
}

const outcomes = (ended: ChannelTurnEnded[]) => ended.map((turn) => turn.outcome);

const askFrames = (resume: Promise<void>) =>
  async function* (): AsyncGenerator<ScriptedFrame> {
    yield {
      kind: 'elicitation',
      id: 'ask-1',
      request: {
        id: 'ask-1',
        source: 'ask',
        questions: [
          { id: 'note', prompt: 'Anything else?', input: { type: 'text' }, defaults: [] },
        ],
      },
    };
    await resume;
    yield { kind: 'text', text: 'Went with defaults.' };
  };

/** A service that asks a question, and goes on once it is skipped. */
function asking() {
  let resumed!: () => void;
  const resume = new Promise<void>((resolve) => {
    resumed = resolve;
  });
  const service = fakeService(askFrames(resume), { answer: async () => {} });
  service.skip = async (who, toolCallId, opts) => {
    service.skipped.push({ actor: who, toolCallId, ...opts });
    resumed();
  };
  return service;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('onTurnEnded', () => {
  it('is told once, after the reply went out, with the turn', async () => {
    const { ended, events, say } = handler(fakeService([{ kind: 'text', text: 'Hello' }]));
    await say('hi', { id: 'm-1' });
    expect(ended).toEqual([
      {
        channel: 'test',
        conversation: 'chat-1',
        actor,
        message: expect.objectContaining({ id: 'm-1', text: 'hi' }),
        runId: 'run-1',
        threadId: 't',
        outcome: 'replied',
      },
    ]);
    expect(events).toEqual(['ack:hi', 'sent:Hello', 'ended:replied']);
  });

  it('is told once per message read, in order', async () => {
    const { ended, say } = handler(fakeService([{ kind: 'text', text: 'ok' }]));
    await say('one');
    await say('two');
    await say('three');
    expect(ended.map((turn) => [turn.message?.text, turn.runId, turn.outcome])).toEqual([
      ['one', 'run-1', 'replied'],
      ['two', 'run-2', 'replied'],
      ['three', 'run-3', 'replied'],
    ]);
  });

  it('is told after a turn that sent nothing (silent, or every message refused)', async () => {
    const silent = handler(fakeService([]));
    await silent.say('hi');
    expect(silent.outbox).toEqual([]);
    expect(outcomes(silent.ended)).toEqual(['replied']);

    const refused = handler(fakeService([{ kind: 'text', text: 'secret' }]), {
      canDeliver: () => false,
    });
    await refused.say('hi');
    expect(refused.outbox).toEqual([]);
    expect(outcomes(refused.ended)).toEqual(['replied']);
  });

  it('is told after a failed turn, a timed-out one and a blocked one', async () => {
    const failed = handler(fakeService([{ kind: 'fail', code: 'run_failed', message: 'boom' }]));
    await failed.say('hi');
    expect(texts(failed.outbox)).toEqual(['Sorry, something went wrong. Please try again.']);
    expect(outcomes(failed.ended)).toEqual(['failed']);

    const slow = fakeService(() =>
      (async function* (): AsyncGenerator<ScriptedFrame> {
        yield* await never<ScriptedFrame[]>();
      })(),
    );
    const timedOut = handler(slow, { timeoutMs: 20 });
    await timedOut.say('hi');
    expect(slow.cancelled).toEqual(['run-1']);
    expect(timedOut.ended.map((turn) => [turn.runId, turn.outcome])).toEqual([
      ['run-1', 'timeout'],
    ]);

    const blocked = handler(
      fakeService([{ kind: 'approval-requested', id: 'call-1', approver: 'requester' }]),
    );
    await blocked.say('refund');
    expect(outcomes(blocked.ended)).toEqual(['blocked']);
  });

  it('is told when the job fails after its retries, with the error — onError too', async () => {
    const boom = new Error('provider down');
    const errors: unknown[] = [];
    const { adapter } = fakeAdapter();
    adapter.send = async () => {
      throw boom;
    };
    const ended: ChannelTurnEnded[] = [];
    const handle = channel(adapter, fakeService([{ kind: 'text', text: 'Hello' }]), {
      retry: { attempts: 2, backoffMs: 1 },
      onError: (error) => errors.push(error),
      onTurnEnded: (turn) => {
        ended.push(turn);
      },
    });
    await handle.handle(request(inbound('hi')));
    await handle.drain();
    expect(errors).toEqual([boom]);
    // Once for the job, not once per attempt of its phase.
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({ outcome: 'failed', error: boom, runId: 'run-1' });
  });

  it('is told when no turn ran: an unknown sender, a beforeTurn stop, nothing to answer', async () => {
    const unknown = handler(fakeService([]), { actor: () => null });
    await unknown.say('hi');
    expect(unknown.events).toEqual(['ack:hi', 'ended:stopped']);
    expect(unknown.ended[0]).toMatchObject({ actor: null, runId: null, outcome: 'stopped' });

    const gated = handler(fakeService([]), {
      beforeTurn: (message) => (message.text === 'quiet' ? 'stop' : { reply: 'Accept the terms.' }),
    });
    await gated.say('quiet');
    await gated.say('terms');
    expect(texts(gated.outbox)).toEqual(['Accept the terms.']);
    expect(gated.ended.map((turn) => [turn.actor?.id, turn.runId, turn.outcome])).toEqual([
      ['u1', null, 'stopped'],
      ['u1', null, 'stopped'],
    ]);

    const service = fakeService([]);
    const empty = handler(service);
    await empty.say('   ');
    expect(service.sends).toEqual([]);
    expect(empty.ended[0]).toMatchObject({ actor, threadId: 't', runId: null, outcome: 'handled' });
  });

  it('a hook that throws is logged and changes nothing', async () => {
    const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    const errors: unknown[] = [];
    const { adapter, outbox } = fakeAdapter();
    let calls = 0;
    const handle = channel(adapter, fakeService([{ kind: 'text', text: 'ok' }]), {
      onError: (error) => errors.push(error),
      onTurnEnded: async () => {
        calls += 1;
        throw new Error('presence service down');
      },
    });
    await handle.handle(request(inbound('one')));
    await handle.handle(request(inbound('two')));
    await handle.drain();
    expect(texts(outbox)).toEqual(['ok', 'ok']);
    expect(calls).toBe(2);
    expect(errors).toEqual([]);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('presence service down'));
  });

  it('a question parks the turn; the run resumed after its timeout is told on its own', async () => {
    const { ended, outbox, say } = handler(asking(), { questionTimeoutMs: 30 });
    await say('order');
    await until(() => texts(outbox).at(-1) === 'Went with defaults.');
    await until(() => ended.length === 2);
    expect(ended.map((turn) => [turn.message?.text ?? null, turn.runId, turn.outcome])).toEqual([
      ['order', 'run-1', 'parked'],
      // The resumed run: no message of its own.
      [null, 'run-1', 'replied'],
    ]);
    expect(ended[1]).toMatchObject({ actor, threadId: 't', conversation: 'chat-1' });
  });

  it('runs under a durable engine too — once for the message, once for its resumed run', async () => {
    const engine = engineOver(new InMemoryStateStore());
    const { handle, ended, outbox, say } = handler(asking(), { engine, questionTimeoutMs: 30 });
    await say('order');
    expect(outcomes(ended)).toEqual(['parked']);
    await new Promise((resolve) => setTimeout(resolve, 40));
    await engine.resumeDueTimers();
    await engine.waitForRun('agora.channel:test:timeout:run-1:ask-1', { until: 'terminal' });
    await handle.drain();
    expect(texts(outbox).at(-1)).toBe('Went with defaults.');
    expect(ended.map((turn) => [turn.message?.text ?? null, turn.runId, turn.outcome])).toEqual([
      ['order', 'run-1', 'parked'],
      [null, 'run-1', 'replied'],
    ]);
  });
});
