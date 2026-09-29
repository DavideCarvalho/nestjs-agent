import { InMemoryAgentStore, InMemoryTokenStreamSink } from '@dudousxd/nestjs-agent-testing';
import { describe, expect, it } from 'vitest';
import {
  type AgentLoopDeps,
  type AgentStreamEvent,
  DefaultRolesPolicy,
  type ModelProvider,
  type SinkWriter,
  ToolRegistry,
  encodeStreamEvent,
  observeTurnFrames,
  runAgentLoop,
  withTurnFrames,
} from './index.js';

function nullWriter(): SinkWriter & { chunks: Uint8Array[] } {
  const chunks: Uint8Array[] = [];
  return { chunks, write: (chunk) => void chunks.push(chunk), end: () => {}, fail: () => {} };
}

/** A clock the test advances by hand. */
function manualClock(start = 1_000) {
  let at = start;
  return {
    now: () => at,
    advance: (ms: number) => {
      at += ms;
    },
  };
}

describe('observeTurnFrames', () => {
  it('accumulates reasoning text and times each burst up to the next non-reasoning frame', async () => {
    const clock = manualClock();
    const inner = nullWriter();
    const frames = observeTurnFrames(inner, clock.now);
    const write = (event: AgentStreamEvent) => frames.writer.write(encodeStreamEvent(event));

    await write({ kind: 'reasoning', text: 'Let me ' });
    clock.advance(1_500);
    await write({ kind: 'reasoning', text: 'think.' });
    clock.advance(500);
    await write({ kind: 'text', text: 'Answer' }); // burst 1: 2000ms
    clock.advance(10_000); // not thinking
    await write({ kind: 'reasoning', text: ' More.' });
    clock.advance(700); // burst 2 still open at the end of the turn

    expect(frames.summary()).toEqual({ reasoning: 'Let me think. More.', reasoningMs: 2_700 });
    expect(inner.chunks).toHaveLength(4);
  });

  it('keeps pushed components in first-seen order with the latest props per id', async () => {
    const frames = observeTurnFrames(nullWriter());
    for (const event of [
      { kind: 'ui', id: 'a', component: 'table', props: { rows: 0 } },
      { kind: 'ui', id: 'b', component: 'chart', props: {}, version: 2 },
      { kind: 'ui', id: 'a', component: 'table', props: { rows: 3 } },
    ] satisfies AgentStreamEvent[]) {
      await frames.writer.write(encodeStreamEvent(event));
    }
    expect(frames.summary()).toEqual({
      ui: [
        { id: 'a', component: 'table', props: { rows: 3 } },
        { id: 'b', component: 'chart', props: {}, version: 2 },
      ],
    });
  });

  it('reads frames split across writes and ignores opaque bytes', async () => {
    const frames = observeTurnFrames(nullWriter());
    const line = encodeStreamEvent({ kind: 'reasoning', text: 'ok' });
    await frames.writer.write(new TextEncoder().encode('raw provider text'));
    await frames.writer.write(new TextEncoder().encode('\n'));
    await frames.writer.write(line.slice(0, 5));
    await frames.writer.write(line.slice(5));
    expect(frames.summary().reasoning).toBe('ok');
  });

  it('reports nothing for a turn with no thinking and no components', () => {
    expect(observeTurnFrames(nullWriter()).summary()).toEqual({});
  });
});

describe('withTurnFrames', () => {
  it("fills only what the provider did not report — the provider's own values win", () => {
    const base = { text: '', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } };
    expect(
      withTurnFrames({ ...base, reasoning: 'mine' }, { reasoning: 'frames', reasoningMs: 5 }),
    ).toEqual({ ...base, reasoning: 'mine', reasoningMs: 5 });
  });
});

describe('runAgentLoop — reasoning and pushed UI reach the stored message', () => {
  it("persists each step's reasoning, thinking time and components on that step's message", async () => {
    const store = new InMemoryAgentStore();
    const sink = new InMemoryTokenStreamSink();
    const thread = await store.createThread({ actor: { id: 'u1', roles: [] } });
    const model: ModelProvider = {
      async runTurn({ sink: writer }) {
        await writer.write(encodeStreamEvent({ kind: 'reasoning', text: 'Considering…' }));
        await writer.write(
          encodeStreamEvent({ kind: 'ui', id: 'u1', component: 'stat', props: { value: 7 } }),
        );
        await writer.write(encodeStreamEvent({ kind: 'text', text: 'Seven.' }));
        return { text: 'Seven.', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const deps: AgentLoopDeps = {
      model,
      store,
      registry: new ToolRegistry(),
      rolesPolicy: new DefaultRolesPolicy(),
      modelId: 'fake-1',
      day: '2026-09-29',
      systemPrompt: 'test',
    };
    await runAgentLoop(
      deps,
      { threadId: thread.id, actor: { id: 'u1', roles: [] }, userText: 'how many?' },
      {
        runId: 'run-1',
        openSink: () => sink.open('run-1'),
        awaitApproval: async () => ({ approved: true }),
        step: (_name, fn) => fn(),
      },
    );
    const assistant = (await store.getThread(thread.id))?.messages.find(
      (message) => message.role === 'assistant',
    );
    expect(assistant?.reasoning).toBe('Considering…');
    expect(typeof assistant?.reasoningMs).toBe('number');
    expect(assistant?.ui).toEqual([{ id: 'u1', component: 'stat', props: { value: 7 } }]);

    // The live stream carries the same duration the message persisted.
    const decoder = new TextDecoder();
    let streamed = '';
    for await (const chunk of sink.subscribe('run-1')) streamed += decoder.decode(chunk);
    const stepFinish = streamed
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line) as AgentStreamEvent)
      .find((event) => event.kind === 'step-finish');
    expect(stepFinish).toMatchObject({ reasoningMs: assistant?.reasoningMs });
  });
});
