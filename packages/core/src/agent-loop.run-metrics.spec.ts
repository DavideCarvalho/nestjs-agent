import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { InMemoryAgentStore, InMemoryTokenStreamSink } from '@dudousxd/nestjs-agent-testing';
import { channelName } from '@dudousxd/nestjs-diagnostics';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  type AgentLoopDeps,
  type AgentLoopHooks,
  type AgentRunFinished,
  type AgentStore,
  type AgentToolCallEvent,
  DefaultRolesPolicy,
  type ModelProvider,
  type ModelTurnArgs,
  type ModelTurnResult,
  type RecordRunEndInput,
  ToolRegistry,
  encodeStreamEvent,
  runAgentLoop,
  runDurationMs,
} from './index.js';

const ACTOR = { id: 'u1', roles: ['ADMIN'], tenantRef: 'tenant-1' };

/** One scripted model call: the text it streams as real `text` frames, and what it reports. */
interface ScriptedTurn {
  text: string;
  toolCall?: { id: string; name: string; input: unknown };
  modelId?: string;
  costUsd?: number;
}

/**
 * A provider that streams its text the way the AI SDK adapter does — as encoded `text` frames — so
 * the loop's first-text observer sees what a real reader would.
 */
class ScriptedModel implements ModelProvider {
  calls = 0;
  constructor(private readonly turns: ScriptedTurn[]) {}
  async runTurn(args: ModelTurnArgs): Promise<ModelTurnResult> {
    const turn = this.turns[this.calls] ?? { text: 'done' };
    this.calls += 1;
    if (turn.text.length > 0) {
      await args.sink.write(encodeStreamEvent({ kind: 'text', text: turn.text }));
    }
    return {
      text: turn.text,
      toolCalls: turn.toolCall !== undefined ? [turn.toolCall] : [],
      usage: { inputTokens: 10, outputTokens: 5 },
      ...(turn.modelId !== undefined ? { modelId: turn.modelId } : {}),
      ...(turn.costUsd !== undefined ? { costUsd: turn.costUsd } : {}),
    };
  }
}

function registry(): ToolRegistry {
  const reg = new ToolRegistry();
  reg.register(
    {
      name: 'slowRead',
      kind: 'read',
      description: 'a read that takes a while',
      inputSchema: z.object({}),
    },
    {
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return { ok: true };
      },
    },
  );
  reg.register(
    {
      name: 'purge',
      kind: 'action',
      description: 'an action that needs approval',
      inputSchema: z.object({}),
    },
    { execute: async () => ({ purged: true }) },
  );
  return reg;
}

/** Collects the payloads published on an agent channel while a test runs. */
function listen<T>(event: string): { payloads: T[]; stop: () => void } {
  const payloads: T[] = [];
  const name = channelName('agent', event as 'run.finished');
  const listener = (message: unknown) => void payloads.push((message as { payload: T }).payload);
  subscribe(name, listener);
  return { payloads, stop: () => unsubscribe(name, listener) };
}

function markedSuspendSignal(): Error {
  const signal = new Error('workflow suspended');
  signal.name = 'WorkflowSuspended';
  return Object.assign(signal, { [Symbol.for('aviary:durable:control-flow')]: true });
}

interface Setup {
  model: ScriptedModel;
  store: InMemoryAgentStore;
  ends: RecordRunEndInput[];
  deps: AgentLoopDeps;
  threadId: string;
}

async function setup(turns: ScriptedTurn[]): Promise<Setup> {
  const store = new InMemoryAgentStore();
  const ends: RecordRunEndInput[] = [];
  const recordRunEnd = store.recordRunEnd.bind(store);
  const wrapped: AgentStore = Object.assign(store, {
    recordRunEnd: async (end: RecordRunEndInput) => {
      ends.push(end);
      await recordRunEnd(end);
    },
  });
  const thread = await store.createThread({ actor: ACTOR });
  const model = new ScriptedModel(turns);
  return {
    model,
    store,
    ends,
    threadId: thread.id,
    deps: {
      model,
      store: wrapped,
      registry: registry(),
      rolesPolicy: new DefaultRolesPolicy(),
      modelId: 'configured-model',
      day: '2026-10-21',
      systemPrompt: 'You are a test agent.',
    },
  };
}

describe('run metrics on run.finished and the run row', () => {
  let finished: ReturnType<typeof listen<AgentRunFinished>>;
  let toolCalls: ReturnType<typeof listen<AgentToolCallEvent>>;
  beforeEach(() => {
    finished = listen<AgentRunFinished>('run.finished');
    toolCalls = listen<AgentToolCallEvent>('tool-call');
  });
  afterEach(() => {
    finished.stop();
    toolCalls.stop();
  });

  it('reports ttft, summed cost, the last model and the run context', async () => {
    const { deps, ends, threadId } = await setup([
      {
        text: 'Let me check.',
        toolCall: { id: 'call-1', name: 'slowRead', input: {} },
        modelId: 'model-a',
        costUsd: 0.01,
      },
      { text: 'All good.', modelId: 'model-b', costUsd: 0.02 },
    ]);
    const sink = new InMemoryTokenStreamSink();
    const hooks: AgentLoopHooks = {
      runId: 'run-1',
      openSink: () => sink.open('run-1'),
      awaitApproval: async () => ({ approved: true }),
      step: (_name, fn) => fn(),
    };
    await runAgentLoop(
      deps,
      { threadId, actor: ACTOR, userText: 'hi', agentName: 'helper', parentRunId: 'parent-1' },
      hooks,
    );

    expect(finished.payloads).toHaveLength(1);
    const payload = finished.payloads[0];
    expect(payload).toMatchObject({
      runId: 'run-1',
      threadId,
      actorId: 'u1',
      agentName: 'helper',
      tenantRef: 'tenant-1',
      parentRunId: 'parent-1',
      steps: 2,
      modelId: 'model-b',
    });
    expect(payload?.costUsd).toBeCloseTo(0.03);
    expect(payload?.ttftMs).toBeGreaterThanOrEqual(0);
    // The first text went out before the tool ran, so it precedes the whole run's end by at least
    // the tool's own time.
    expect((payload?.durationMs ?? 0) - (payload?.ttftMs ?? 0)).toBeGreaterThanOrEqual(20);

    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({
      runId: 'run-1',
      status: 'completed',
      ttftMs: payload?.ttftMs,
      durationMs: payload?.durationMs,
      modelId: 'model-b',
    });
    expect(ends[0]?.costUsd).toBeCloseTo(0.03);

    expect(toolCalls.payloads).toHaveLength(1);
    expect(toolCalls.payloads[0]).toMatchObject({
      runId: 'run-1',
      toolCallId: 'call-1',
      toolName: 'slowRead',
      status: 'executed',
    });
    expect(toolCalls.payloads[0]?.durationMs).toBeGreaterThanOrEqual(20);
    expect(toolCalls.payloads[0]).not.toHaveProperty('replayed');
  });

  it('leaves ttft and cost out when the run streamed no text and no call had a known cost', async () => {
    const { deps, ends, threadId } = await setup([{ text: '' }]);
    const sink = new InMemoryTokenStreamSink();
    // No configured model and none reported: nothing to name.
    const { modelId: _configured, ...unnamed } = deps;
    await runAgentLoop(
      unnamed,
      { threadId, actor: { id: 'u2' }, userText: 'hi' },
      {
        runId: 'run-2',
        openSink: () => sink.open('run-2'),
        awaitApproval: async () => ({ approved: true }),
        step: (_name, fn) => fn(),
      },
    );
    const payload = finished.payloads[0];
    expect(payload).toMatchObject({ runId: 'run-2', actorId: 'u2' });
    expect(payload).not.toHaveProperty('ttftMs');
    expect(payload).not.toHaveProperty('costUsd');
    expect(payload).not.toHaveProperty('modelId');
    expect(payload).not.toHaveProperty('tenantRef');
    expect(ends[0]).not.toHaveProperty('ttftMs');
    expect(ends[0]).not.toHaveProperty('costUsd');
  });

  it('keeps the journaled ttft across a replay and marks re-published tool outcomes replayed', async () => {
    const { deps, threadId, model } = await setup([
      { text: 'Reading first.', toolCall: { id: 'call-read', name: 'slowRead', input: {} } },
      { text: 'Now purging.', toolCall: { id: 'call-purge', name: 'purge', input: {} } },
      { text: 'Purged.' },
    ]);
    const sink = new InMemoryTokenStreamSink();
    const journal = new Map<string, unknown>();
    let parked = true;
    const hooks: AgentLoopHooks = {
      runId: 'run-3',
      openSink: () => sink.open('run-3'),
      // The first execution parks on the approval the way a durable runner suspends; the resume
      // replays every checkpoint the journal holds and then gets its answer.
      awaitApproval: async () => {
        if (parked) {
          parked = false;
          throw markedSuspendSignal();
        }
        return { approved: true };
      },
      step: async (name, fn) => {
        if (journal.has(name)) {
          return journal.get(name) as never;
        }
        const value = await fn();
        journal.set(name, value);
        return value;
      },
    };
    const input = { threadId, actor: ACTOR, userText: 'hi' };

    await expect(runAgentLoop(deps, input, hooks)).rejects.toThrow('workflow suspended');
    expect(toolCalls.payloads).toEqual([
      expect.objectContaining({ toolCallId: 'call-read', status: 'executed' }),
    ]);
    expect(toolCalls.payloads[0]).not.toHaveProperty('replayed');
    expect(toolCalls.payloads[0]?.durationMs).toBeGreaterThanOrEqual(20);
    const callsBeforeResume = model.calls;

    await runAgentLoop(deps, input, hooks);
    // Only the turn after the approval called the model again.
    expect(model.calls).toBe(callsBeforeResume + 1);

    const replayedRead = toolCalls.payloads[1];
    expect(replayedRead).toMatchObject({ toolCallId: 'call-read', replayed: true });
    // A replay's time around the call is the time to read the journal, never the tool's.
    expect(replayedRead).not.toHaveProperty('durationMs');
    expect(toolCalls.payloads[2]).toMatchObject({ toolCallId: 'call-purge', status: 'executed' });
    expect(toolCalls.payloads[2]).not.toHaveProperty('replayed');

    const startedAt = journal.get('run:started-at') as number;
    const firstTurn = journal.get('llm:0') as { firstTextAt?: number };
    expect(typeof firstTurn.firstTextAt).toBe('number');
    expect(finished.payloads).toHaveLength(1);
    expect(finished.payloads[0]?.ttftMs).toBe((firstTurn.firstTextAt ?? 0) - startedAt);
  });
});

describe('runDurationMs', () => {
  it("measures a failed run from the run's journaled start", async () => {
    const { deps, threadId } = await setup([]);
    const failing: ModelProvider = {
      runTurn: async () => {
        throw new Error('provider down');
      },
    };
    const sink = new InMemoryTokenStreamSink();
    const error = await runAgentLoop(
      { ...deps, model: failing },
      { threadId, actor: ACTOR, userText: 'hi' },
      {
        runId: 'run-4',
        openSink: () => sink.open('run-4'),
        awaitApproval: async () => ({ approved: true }),
        step: (_name, fn) => fn(),
      },
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(runDurationMs(error)).toBeGreaterThanOrEqual(0);
  });

  it('is undefined for a run that failed before its start was recorded', async () => {
    const { deps, threadId, store } = await setup([]);
    const refusing: AgentStore = Object.assign(Object.create(store) as InMemoryAgentStore, {
      appendMessage: async () => {
        throw new Error('database unavailable');
      },
    });
    const sink = new InMemoryTokenStreamSink();
    const error = await runAgentLoop(
      { ...deps, store: refusing },
      { threadId, actor: ACTOR, userText: 'hi' },
      {
        runId: 'run-5',
        openSink: () => sink.open('run-5'),
        awaitApproval: async () => ({ approved: true }),
        step: (_name, fn) => fn(),
      },
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(runDurationMs(error)).toBeUndefined();
  });

  it('is undefined for anything that did not come out of the loop', () => {
    expect(runDurationMs(new Error('elsewhere'))).toBeUndefined();
    expect(runDurationMs('a string')).toBeUndefined();
  });
});
