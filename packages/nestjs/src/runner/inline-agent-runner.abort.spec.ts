import {
  type AgentStore,
  DefaultRolesPolicy,
  type ModelProvider,
  type ModelTurnArgs,
  type RecordRunEndInput,
  ToolRegistry,
  decodeStreamEvent,
  encodeStreamEvent,
} from '@dudousxd/nestjs-agent-core';
import { InMemoryAgentStore } from '@dudousxd/nestjs-agent-testing';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AgentDepsFactory } from '../agent-deps.factory.js';
import type { AgentDeps } from '../agent-deps.js';
import { InProcessTokenStreamSink } from '../in-process-sink.js';
import { InlineAgentRunner } from './inline-agent-runner.js';

/**
 * A Stop aborts what the run is waiting on — the model call streaming the answer, a tool that takes
 * the signal — instead of letting it run to the end of the step. The run still ends `cancelled`, and
 * the thread keeps the steps that finished, not the one the Stop cut short.
 */

const ACTOR = { id: 'u1', roles: ['ADMIN'] };
/** Long enough that a call nobody aborted is plainly still running when the test looks. */
const HANG_MS = 3000;

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** Resolves on `signal`'s abort (to `true`), or after {@link HANG_MS} when nothing aborts it. */
function abortedOrTimeout(signal: AbortSignal | undefined): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), HANG_MS);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function harness(model: ModelProvider, registry = new ToolRegistry()) {
  const inner = new InMemoryAgentStore();
  const settled = deferred<RecordRunEndInput>();
  const store: AgentStore = Object.assign(Object.create(inner) as InMemoryAgentStore, {
    recordRunEnd: async (end: RecordRunEndInput) => {
      settled.resolve(end);
      await inner.recordRunEnd(end);
    },
  });
  const sink = new InProcessTokenStreamSink();
  const deps: AgentDeps = {
    model,
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
  const factory = { forAgent: () => deps } as unknown as AgentDepsFactory;
  const runner = new InlineAgentRunner(factory, store);
  const threadId = (await inner.createThread({ actor: ACTOR })).id;
  return { runner, sink, store: inner, threadId, settled: settled.promise };
}

async function drain(sink: InProcessTokenStreamSink, runId: string) {
  const frames: unknown[] = [];
  for await (const chunk of sink.subscribe(runId)) {
    for (const line of new TextDecoder().decode(chunk).split('\n')) {
      const event = line.length > 0 ? decodeStreamEvent(line) : null;
      if (event !== null) frames.push(event);
    }
  }
  return frames;
}

describe('cancelling an inline run aborts its in-flight work', () => {
  it.each([
    ['ends its stream early', false],
    ['rejects like the AI SDK does', true],
  ])('aborts the model call mid-stream (a provider that %s)', async (_label, rejects) => {
    const streaming = deferred();
    let aborted: boolean | undefined;
    const model: ModelProvider = {
      async runTurn(args: ModelTurnArgs) {
        await args.sink.write(encodeStreamEvent({ kind: 'text', text: 'Hel' }));
        streaming.resolve();
        aborted = await abortedOrTimeout(args.abortSignal);
        if (aborted && rejects) {
          throw new DOMException('This operation was aborted', 'AbortError');
        }
        await args.sink.write(encodeStreamEvent({ kind: 'text', text: 'lo there' }));
        return { text: 'Hello there', toolCalls: [], usage: { inputTokens: 1, outputTokens: 2 } };
      },
    };
    const h = await harness(model);
    const started = Date.now();
    const { runId } = await h.runner.start({ threadId: h.threadId, actor: ACTOR, userText: 'hi' });
    await streaming.promise;
    await h.runner.cancel(runId);
    const end = await h.settled;
    const frames = await drain(h.sink, runId);

    expect(aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(HANG_MS);
    expect(end.status).toBe('cancelled');
    expect(frames.at(-1)).toEqual({ kind: 'cancelled' });
    expect(frames.some((frame) => (frame as { kind: string }).kind === 'error')).toBe(false);
    // The step the Stop cut short is not persisted.
    const thread = await h.store.getThread(h.threadId);
    expect(thread?.messages.map((message) => message.role)).toEqual(['user']);
  });

  it('hands a running tool the abort, and keeps the step that finished', async () => {
    const executing = deferred();
    let toolSawAbort: boolean | undefined;
    let modelCalls = 0;
    const model: ModelProvider = {
      async runTurn(args: ModelTurnArgs) {
        modelCalls += 1;
        await args.sink.write(encodeStreamEvent({ kind: 'text', text: 'Checking' }));
        return {
          text: 'Checking',
          toolCalls: [{ id: 'call-slow', name: 'slow', input: {} }],
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };
    const registry = new ToolRegistry();
    registry.register(
      { name: 'slow', kind: 'read', description: 'slow', inputSchema: z.object({}) },
      {
        async execute(_input, ctx) {
          executing.resolve();
          toolSawAbort = await abortedOrTimeout(ctx.abortSignal);
          if (toolSawAbort) throw new DOMException('This operation was aborted', 'AbortError');
          return { done: true };
        },
      },
    );
    const h = await harness(model, registry);
    const started = Date.now();
    const { runId } = await h.runner.start({ threadId: h.threadId, actor: ACTOR, userText: 'hi' });
    await executing.promise;
    await h.runner.cancel(runId);
    const end = await h.settled;
    const frames = await drain(h.sink, runId);

    expect(toolSawAbort).toBe(true);
    expect(Date.now() - started).toBeLessThan(HANG_MS);
    expect(modelCalls).toBe(1);
    expect(end.status).toBe('cancelled');
    expect(frames.at(-1)).toEqual({ kind: 'cancelled' });
    const thread = await h.store.getThread(h.threadId);
    expect(thread?.messages.map((message) => [message.role, message.content])).toEqual([
      ['user', 'hi'],
      ['assistant', 'Checking'],
    ]);
  });
});
