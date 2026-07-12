import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import {
  FakeModelProvider,
  type FakeScript,
  InMemoryAgentStore,
  InMemoryTokenStreamSink,
} from '@dudousxd/nestjs-agent-testing';
import type { SpanEvent } from '@dudousxd/nestjs-diagnostics';
import { traceChannelNames } from '@dudousxd/nestjs-diagnostics';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AGENT_SPAN_EVENTS,
  type AgentLoopDeps,
  type AgentLoopHooks,
  DefaultRolesPolicy,
  type ModelProvider,
  ToolRegistry,
  runAgentLoop,
} from './index.js';

/**
 * Span-emission tests for the agent loop: every genuinely-executing work site (llm call, tool
 * execution, inject-mode retrieval, follow-ups) publishes an `aviary:agent:<event>:<phase>` span
 * via the diagnostics `trace()` API, correlated by `traceId = runId` — and a replayed run (steps
 * resolving from checkpoints, bodies skipped) publishes NONE.
 */

const RUN_ID = 'run-1';
const USER_TEXT = 'what is the weather in Lisbon?';
const REPLY_TEXT = 'It is sunny in Lisbon.';

/** Every phase envelope seen on any agent span sub-channel while subscribed. */
const seen: SpanEvent[] = [];
const listeners: Array<{ channel: string; handler: (message: unknown) => void }> = [];

function subscribeAllSpanChannels(): void {
  for (const event of AGENT_SPAN_EVENTS) {
    const names = traceChannelNames('agent', event);
    for (const channel of [names.start, names.end, names.asyncStart, names.asyncEnd, names.error]) {
      const handler = (message: unknown) => seen.push(message as SpanEvent);
      subscribe(channel, handler);
      listeners.push({ channel, handler });
    }
  }
}

afterEach(() => {
  while (listeners.length) {
    const listener = listeners.pop();
    if (listener) unsubscribe(listener.channel, listener.handler);
  }
  seen.length = 0;
});

function buildRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(
    {
      name: 'getWeather',
      kind: 'read',
      description: 'weather',
      inputSchema: z.object({ city: z.string() }),
    },
    { execute: async (input: { city: string }) => ({ tempC: 21, city: input.city }) },
  );
  return registry;
}

/**
 * Script: turn 0 calls getWeather, turn 1 answers, turn 2 is the follow-ups call (its own extra
 * model call, so the FakeModelProvider's assistant-count turnIndex reaches 2).
 */
const script: FakeScript = (_args, turnIndex) => {
  if (turnIndex === 0) {
    return { text: 'checking...', toolCall: { name: 'getWeather', input: { city: 'Lisbon' } } };
  }
  if (turnIndex === 1) {
    return { text: REPLY_TEXT };
  }
  return { text: '["Will it rain tomorrow?"]' };
};

function buildDeps(model: ModelProvider, store: InMemoryAgentStore): AgentLoopDeps {
  return {
    model,
    store,
    registry: buildRegistry(),
    rolesPolicy: new DefaultRolesPolicy(),
    modelId: 'fake-1',
    day: '2026-07-11',
    systemPrompt: 'You are a test agent.',
    followUpsCount: 2,
    retriever: {
      retrieve: async () => [
        { text: 'Lisbon is in Portugal.', source: 'geo' },
        { text: 'Averages 300 sunny days.', source: 'climate' },
      ],
    },
  };
}

async function runOnce(
  deps: AgentLoopDeps,
  store: InMemoryAgentStore,
  step: AgentLoopHooks['step'],
): Promise<void> {
  const sink = new InMemoryTokenStreamSink();
  const thread = await store.createThread({ actor: { id: 'u1', roles: ['ADMIN'] } });
  await runAgentLoop(
    deps,
    { threadId: thread.id, actor: { id: 'u1', roles: ['ADMIN'] }, userText: USER_TEXT },
    {
      runId: RUN_ID,
      openSink: () => sink.open(RUN_ID),
      awaitApproval: async () => ({ approved: true }),
      step,
    },
  );
}

describe('agent loop span emission', () => {
  it('emits llm.turn / tool.execution / retrieval / follow-ups spans with traceId = runId', async () => {
    subscribeAllSpanChannels();
    const store = new InMemoryAgentStore();
    await runOnce(buildDeps(new FakeModelProvider(script), store), store, (_name, fn) => fn());

    const startsByEvent = new Map<string, SpanEvent[]>();
    for (const envelope of seen) {
      if (envelope.phase !== 'start') continue;
      const bucket = startsByEvent.get(envelope.event) ?? [];
      bucket.push(envelope);
      startsByEvent.set(envelope.event, bucket);
    }
    // Two model calls (tool turn + final turn), one tool execution, one retrieval, one follow-ups.
    expect(startsByEvent.get('llm.turn')).toHaveLength(2);
    expect(startsByEvent.get('tool.execution')).toHaveLength(1);
    expect(startsByEvent.get('retrieval')).toHaveLength(1);
    expect(startsByEvent.get('follow-ups')).toHaveLength(1);

    // Every phase envelope of every span carries the run as its traceId.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((envelope) => envelope.traceId === RUN_ID)).toBe(true);
    // No error phases in a clean run.
    expect(seen.some((envelope) => envelope.phase === 'error')).toBe(false);

    // Terminal phases carry timing for the waterfall.
    const terminal = seen.filter((envelope) => envelope.phase === 'asyncEnd');
    expect(terminal.length).toBeGreaterThan(0);
    expect(terminal.every((envelope) => typeof envelope.durationMs === 'number')).toBe(true);

    // Redaction: metadata only — lengths and counts, never the prompt/user/reply text.
    const wire = JSON.stringify(seen);
    expect(wire).not.toContain(USER_TEXT);
    expect(wire).not.toContain(REPLY_TEXT);
    expect(wire).not.toContain('You are a test agent.');
    const retrievalStart = startsByEvent.get('retrieval')?.[0];
    expect(retrievalStart?.payload).toEqual({
      runId: RUN_ID,
      queryLength: USER_TEXT.length,
      topK: 5,
    });
    const llmEnd = seen.find((e) => e.event === 'llm.turn' && e.phase === 'asyncEnd');
    expect(llmEnd?.result).toMatchObject({ textLength: expect.any(Number) });
  });

  it('emits an error span (and no end) when the tool execution throws', async () => {
    subscribeAllSpanChannels();
    const store = new InMemoryAgentStore();
    const deps = buildDeps(new FakeModelProvider(script), store);
    deps.registry = new ToolRegistry();
    deps.registry.register(
      {
        name: 'getWeather',
        kind: 'read',
        description: 'weather',
        inputSchema: z.object({ city: z.string() }),
      },
      {
        execute: async () => {
          throw new Error('weather service down');
        },
      },
    );
    await runOnce(deps, store, (_name, fn) => fn());

    const toolPhases = seen
      .filter((envelope) => envelope.event === 'tool.execution')
      .map((envelope) => envelope.phase);
    expect(toolPhases).toContain('start');
    expect(toolPhases).toContain('error');
    expect(toolPhases).not.toContain('asyncEnd');
  });

  it('emits NO spans on a replayed run (steps resolve from checkpoints, bodies skipped)', async () => {
    // First run: record every step result, unobserved (subscribe only for the replay).
    const store = new InMemoryAgentStore();
    const checkpoints = new Map<string, unknown>();
    await runOnce(buildDeps(new FakeModelProvider(script), store), store, async (name, fn) => {
      const value = await fn();
      checkpoints.set(name, value);
      return value;
    });

    // Replay: every step returns its checkpoint WITHOUT executing the body — the durable replay
    // contract. The model provider throws if reached, proving no genuine work re-ran.
    subscribeAllSpanChannels();
    const throwingModel: ModelProvider = {
      runTurn: async () => {
        throw new Error('model must not run on replay');
      },
    };
    const replayStore = new InMemoryAgentStore();
    const replayStep: AgentLoopHooks['step'] = <T>(name: string, fn: () => Promise<T>) => {
      if (checkpoints.has(name)) {
        // Cast once at the test boundary: the checkpoint store is untyped by design (a durable
        // engine stores step results as JSON); the loop wrote each value through the same key.
        return Promise.resolve(checkpoints.get(name) as T);
      }
      return fn();
    };
    await runOnce(buildDeps(throwingModel, replayStore), replayStore, replayStep);

    expect(seen).toEqual([]);
  });
});
