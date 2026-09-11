import {
  type AgentStore,
  type RecordRunEndInput,
  decodeStreamEvent,
} from '@dudousxd/nestjs-agent-core';
import {
  FakeModelProvider,
  type FakeScript,
  InMemoryAgentStore,
} from '@dudousxd/nestjs-agent-testing';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AgentDepsFactory } from '../agent-deps.factory.js';
import type { AgentDeps } from '../agent-deps.js';
import { InProcessTokenStreamSink } from '../in-process-sink.js';
import { InlineAgentRunner } from './inline-agent-runner.js';

const ACTOR = { id: 'u1', roles: ['ADMIN'] };

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** A turn that calls a tool, then answers — two model calls unless something stops it. */
const callsThenAnswers: FakeScript = (_args, turnIndex) =>
  turnIndex === 0 ? { text: 'working', toolCall: { name: 'slow', input: {} } } : { text: 'done' };

interface Harness {
  runner: InlineAgentRunner;
  sink: InProcessTokenStreamSink;
  store: InMemoryAgentStore;
  ends: RecordRunEndInput[];
  threadId: string;
  modelCalls: () => number;
  /** Resolves when the runner settles the run's outcome — whatever that outcome turns out to be. */
  settled: Promise<RecordRunEndInput>;
  /** Resolves once the turn's tool has started running. */
  toolRunning: Promise<void>;
  /** Let the tool finish. */
  releaseTool: () => void;
}

async function harness(options: { script?: FakeScript; approvalTool?: boolean } = {}) {
  const inner = new InMemoryAgentStore();
  const ends: RecordRunEndInput[] = [];
  const settled = deferred<RecordRunEndInput>();
  const store: AgentStore = Object.assign(Object.create(inner) as InMemoryAgentStore, {
    recordRunEnd: async (end: RecordRunEndInput) => {
      ends.push(end);
      settled.resolve(end);
      await inner.recordRunEnd(end);
    },
  });
  const sink = new InProcessTokenStreamSink();
  const running = deferred();
  const release = deferred();
  let started = false;
  let modelCalls = 0;
  const { ToolRegistry, DefaultRolesPolicy } = await import('@dudousxd/nestjs-agent-core');
  const registry = new ToolRegistry();
  registry.register(
    {
      name: 'slow',
      kind: options.approvalTool === true ? 'action' : 'read',
      description: 'slow',
      inputSchema: z.object({}),
    },
    {
      execute: async () => {
        if (!started) {
          started = true;
          running.resolve();
        }
        await release.promise;
        return { done: true };
      },
    },
  );
  const scripted = new FakeModelProvider(options.script ?? callsThenAnswers);
  const deps: AgentDeps = {
    model: {
      runTurn: async (args) => {
        modelCalls += 1;
        return scripted.runTurn(args);
      },
    },
    store,
    registry,
    rolesPolicy: new DefaultRolesPolicy(),
    sink,
    modelId: 'fake-1',
    systemPrompt: 'You are a test agent.',
    promptContributors: [],
    maxSteps: 8,
    inputProcessors: [],
    outputProcessors: [],
  };
  const factory: AgentDepsFactory = { forAgent: () => deps } as unknown as AgentDepsFactory;
  const runner = new InlineAgentRunner(factory, store);
  const threadId = (await inner.createThread({ actor: ACTOR })).id;
  return {
    runner,
    sink,
    store: inner,
    ends,
    threadId,
    modelCalls: () => modelCalls,
    settled: settled.promise,
    toolRunning: running.promise,
    releaseTool: () => release.resolve(),
  } satisfies Harness;
}

async function drain(sink: InProcessTokenStreamSink, runId: string) {
  const frames: unknown[] = [];
  let failure: unknown;
  try {
    for await (const chunk of sink.subscribe(runId)) {
      for (const line of new TextDecoder().decode(chunk).split('\n')) {
        if (line.length > 0) {
          const event = decodeStreamEvent(line);
          if (event !== null) {
            frames.push(event);
          }
        }
      }
    }
  } catch (error) {
    failure = error;
  }
  return { frames, failure };
}

describe('the inline runner’s cancel', () => {
  it('stops the turn — the run does not take its next step', async () => {
    const h = await harness();
    const { runId } = await h.runner.start({ threadId: h.threadId, actor: ACTOR, userText: 'hi' });
    await h.toolRunning;
    await h.runner.cancel(runId);
    h.releaseTool();
    await h.settled;
    // The tool that was already running finished (there is no un-executing one), and the turn
    // stopped at the next observation instead of taking its second model call.
    expect(h.modelCalls()).toBe(1);
  });

  it('records the run cancelled, not failed', async () => {
    const h = await harness();
    const { runId } = await h.runner.start({ threadId: h.threadId, actor: ACTOR, userText: 'hi' });
    await h.toolRunning;
    await h.runner.cancel(runId);
    h.releaseTool();
    await h.settled;
    expect(h.ends).toHaveLength(1);
    expect(h.ends[0]?.status).toBe('cancelled');
    expect(h.ends[0]?.errorCode).toBeUndefined();
  });

  it('ends the stream with a cancelled frame rather than a typed failure', async () => {
    const h = await harness();
    const { runId } = await h.runner.start({ threadId: h.threadId, actor: ACTOR, userText: 'hi' });
    await h.toolRunning;
    await h.runner.cancel(runId);
    h.releaseTool();
    await h.settled;
    const { frames, failure } = await drain(h.sink, runId);
    expect(failure).toBeUndefined();
    expect(frames.at(-1)).toEqual({ kind: 'cancelled' });
  });

  it('clears the thread’s active run, so nothing reattaches to a stopped turn', async () => {
    const h = await harness();
    const { runId } = await h.runner.start({ threadId: h.threadId, actor: ACTOR, userText: 'hi' });
    await h.store.setActiveStream(h.threadId, runId);
    await h.toolRunning;
    await h.runner.cancel(runId);
    h.releaseTool();
    await h.settled;
    expect(await h.store.activeRunForThread(h.threadId)).toBeNull();
  });

  it('releases a turn parked on a human instead of leaving it waiting forever', async () => {
    const h = await harness({ approvalTool: true });
    const { runId } = await h.runner.start({ threadId: h.threadId, actor: ACTOR, userText: 'hi' });
    // The action tool parks on an approval that never comes; the tool itself never runs.
    await new Promise((resolve) => setTimeout(resolve, 10));
    await h.runner.cancel(runId);
    await h.settled;
    const { frames, failure } = await drain(h.sink, runId);
    expect(failure).toBeUndefined();
    expect(frames.at(-1)).toEqual({ kind: 'cancelled' });
    expect(h.ends[0]?.status).toBe('cancelled');
    expect(h.modelCalls()).toBe(1);
  });

  it('is a no-op on a run it has never heard of', async () => {
    const h = await harness();
    await expect(h.runner.cancel('no-such-run')).resolves.toBeUndefined();
    expect(h.ends).toEqual([]);
  });
});
