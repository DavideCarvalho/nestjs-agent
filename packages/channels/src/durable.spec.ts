import { InMemoryChannelStore } from '@dudousxd/nestjs-agent-core';
import { InMemoryStateStore, WorkflowEngine } from '@dudousxd/nestjs-durable-core';
import { describe, expect, it } from 'vitest';
import {
  type ScriptedFrame,
  channel,
  fakeAdapter,
  fakeService,
  inbound,
  request,
  texts,
  until,
} from './channels.spec-helper.js';
import type { ChannelWorkflowEngine } from './executor.js';

const never = <T = never>() => new Promise<T>(() => {});

type Engine = ChannelWorkflowEngine & WorkflowEngine;

const engineOver = (store: InMemoryStateStore) =>
  new WorkflowEngine({ store }) as unknown as Engine;

/**
 * A process that dies: its engine keeps holding the run (a hung step never settles), and a second
 * engine over the same durable store — the restarted process, its clock past the dead one's lease —
 * recovers the run with a handler created again under the same channel name.
 */
const restart = (store: InMemoryStateStore) =>
  new WorkflowEngine({ store, clock: () => Date.now() + 10 * 60_000 }) as unknown as Engine;

describe('durable channels (a @dudousxd/nestjs-durable engine)', () => {
  it('persists the message before the 200 and answers it as a run', async () => {
    const engine = engineOver(new InMemoryStateStore());
    const { adapter, outbox } = fakeAdapter();
    const handler = channel(adapter, fakeService([{ kind: 'text', text: 'Hello **there**' }]), {
      engine,
    });
    const answer = await handler.handle(request(inbound('hi', { id: 'm-1' })));
    expect(answer).toEqual({ status: 200, body: { ok: true } });
    const run = await engine.getRun('agora.channel:test:message:m-1');
    expect(run?.workflow).toBe('agora.channel.job');
    expect(run?.input).toMatchObject({ kind: 'message', conversation: 'chat-1' });
    await handler.drain();
    expect(texts(outbox)).toEqual(['Hello *there*']);
    expect((await engine.getRun('agora.channel:test:message:m-1'))?.status).toBe('completed');
  });

  it('answers 500 (and keeps the message retryable) when the engine cannot take it', async () => {
    const { adapter } = fakeAdapter();
    let down = true;
    const engine: ChannelWorkflowEngine = {
      register: () => {},
      start: async () => {
        if (down) throw new Error('database unavailable');
        return {};
      },
    };
    const events: unknown[] = [];
    const handler = channel(adapter, fakeService([]), {
      engine,
      onWebhook: (event) => {
        events.push({ status: event.status, accepted: event.accepted });
      },
    });
    expect((await handler.handle(request(inbound('hi', { id: 'm-1' })))).status).toBe(500);
    down = false;
    expect((await handler.handle(request(inbound('hi', { id: 'm-1' })))).status).toBe(200);
    expect(events).toEqual([
      { status: 'failed', accepted: 0 },
      { status: 'accepted', accepted: 1 },
    ]);
  });

  it('a crash between the 200 and the reply: the restarted process answers once, without a second turn', async () => {
    const durableStore = new InMemoryStateStore();
    const store = new InMemoryChannelStore();
    const { adapter, outbox } = fakeAdapter();
    // The first process starts the turn and dies while reading it.
    const dying = fakeService(() =>
      (async function* (): AsyncGenerator<ScriptedFrame> {
        yield* await never<ScriptedFrame[]>();
      })(),
    );
    const first = channel(adapter, dying, { store, engine: engineOver(durableStore) });
    await first.handle(request(inbound('hi', { id: 'm-1' })));
    await until(() => dying.subscribed.length === 1);
    expect(dying.sends).toHaveLength(1);
    expect(outbox).toEqual([]);

    // The restarted process: the turn has finished meanwhile; its stream replays from the start.
    const engine = restart(durableStore);
    const alive = fakeService([{ kind: 'text', text: 'The answer.' }]);
    channel(adapter, alive, { store, engine });
    await engine.recoverIncomplete();
    await engine.waitForRun('agora.channel:test:message:m-1', { until: 'terminal' });
    // The turn was not started again: the recovered run read the one it had started.
    expect(alive.sends).toEqual([]);
    expect(alive.subscribed).toEqual(['run-1']);
    expect(texts(outbox)).toEqual(['The answer.']);
    // Recovered again (another replica, another tick): nothing more goes out.
    await engine.recoverIncomplete();
    expect(texts(outbox)).toEqual(['The answer.']);
  });

  it('a crash after the turn completed but before its reply went out: relayed once after recovery', async () => {
    const durableStore = new InMemoryStateStore();
    const store = new InMemoryChannelStore();
    const { adapter, outbox } = fakeAdapter();
    const frames: ScriptedFrame[] = [
      { kind: 'text', text: 'Your exam is saved.' },
      { kind: 'tool-input-start', id: 'call-1', name: 'share', toolKind: 'action' },
      {
        kind: 'approval-requested',
        id: 'call-1',
        approver: 'requester',
        target: { kind: 'proposal', proposalId: 'proposal-1' },
        confirmation: { title: 'Share it?', verb: 'Share' },
      },
    ];
    // Every frame of the turn arrived, then the process died before the stream's end was read
    // (nothing is sent before the end).
    const dying = fakeService(() =>
      (async function* () {
        yield* frames;
        await never();
      })(),
    );
    const first = channel(adapter, dying, { store, engine: engineOver(durableStore) });
    await first.handle(request(inbound('save it', { id: 'm-1' })));
    await until(() => dying.subscribed.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(outbox).toEqual([]);

    const engine = restart(durableStore);
    const alive = fakeService(frames);
    const after = channel(adapter, alive, { store, engine });
    await engine.recoverIncomplete();
    await engine.waitForRun('agora.channel:test:message:m-1', { until: 'terminal' });
    expect(texts(outbox)).toEqual([
      'Your exam is saved.',
      '*Share it?*\n\nReply *yes* to confirm or *no* to cancel.',
    ]);
    // The same webhook delivered again after the restart: deduplicated, nothing more.
    await after.handle(request(inbound('save it', { id: 'm-1' })));
    await after.drain();
    expect(outbox).toHaveLength(2);
    expect(alive.sends).toEqual([]);
  });

  it('retries a failed delivery with backoff, sending each message once', async () => {
    const engine = engineOver(new InMemoryStateStore());
    const { adapter, outbox } = fakeAdapter({ maxLength: 20 });
    let failures = 1;
    const send = adapter.send;
    adapter.send = async (conversation, message) => {
      // The second piece fails once (a provider 5xx).
      if (outbox.length === 1 && failures-- > 0) throw new Error('provider unavailable');
      await send(conversation, message);
    };
    const service = fakeService([
      { kind: 'text', text: 'First piece here.\n\nSecond piece here.' },
    ]);
    const handler = channel(adapter, service, { engine, retry: { attempts: 3, backoffMs: 5 } });
    await handler.handle(request(inbound('hi')));
    await handler.drain();
    expect(texts(outbox)).toEqual(['First piece here.', 'Second piece here.']);
    expect(service.sends).toHaveLength(1);
  });

  it('handles the messages of one conversation in order, one at a time — others in parallel', async () => {
    const engine = engineOver(new InMemoryStateStore());
    const { adapter, outbox } = fakeAdapter();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = fakeService((runId) =>
      (async function* () {
        if (runId === 'run-1') await gate;
        yield { kind: 'text', text: `answer to ${runId}` } as ScriptedFrame;
      })(),
    );
    const handler = channel(adapter, service, { engine });
    await handler.handle(request(inbound('first', { id: 'a1' })));
    await until(() => service.sends.length === 1);
    await handler.handle(request(inbound('second', { id: 'a2' })));
    await handler.handle(request(inbound('elsewhere', { id: 'b1', conversation: 'chat-2' })));
    await until(() => outbox.length === 1);
    expect(outbox[0]).toEqual({ conversation: 'chat-2', message: { text: 'answer to run-2' } });
    expect(service.sends.map((send) => send.message)).toEqual(['first', 'elsewhere']);
    release();
    await handler.drain();
    expect(outbox.map((item) => [item.conversation, item.message.text])).toEqual([
      ['chat-2', 'answer to run-2'],
      ['chat-1', 'answer to run-1'],
      ['chat-1', 'answer to run-3'],
    ]);
  });

  it('a question does not hold the conversation; nobody answering skips it on a durable timer', async () => {
    const engine = engineOver(new InMemoryStateStore());
    const { adapter, outbox } = fakeAdapter();
    let resumed!: () => void;
    const resume = new Promise<void>((resolve) => {
      resumed = resolve;
    });
    const service = fakeService(
      async function* () {
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
      },
      { answer: async () => {} },
    );
    service.skip = async (who, toolCallId, opts) => {
      service.skipped.push({ actor: who, toolCallId, ...opts });
      resumed();
    };
    const handler = channel(adapter, service, { engine, questionTimeoutMs: 30 });
    await handler.handle(request(inbound('order', { id: 'q1' })));
    await handler.drain();
    expect(texts(outbox)).toEqual(['*Anything else?*']);
    const timer = await engine.getRun('agora.channel:test:timeout:run-1:ask-1');
    expect(timer?.workflow).toBe('agora.channel.timer');
    await new Promise((resolve) => setTimeout(resolve, 40));
    await engine.resumeDueTimers();
    await engine.waitForRun('agora.channel:test:timeout:run-1:ask-1', { until: 'terminal' });
    await handler.drain();
    expect(service.skipped).toHaveLength(1);
    expect(texts(outbox).at(-1)).toBe('Went with defaults.');
  });
});
