import { channel } from 'node:diagnostics_channel';
import { publishAgentRunFinished } from '@dudousxd/nestjs-agent-core';
import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryScoreStore } from './in-memory-score-store.js';
import { type LiveScoring, attachLiveScoring } from './live-scoring.js';
import { StaticRunSampleSource } from './sample-source.js';
import { RunCompletionScorer } from './scorers/run-completion.scorer.js';
import type { ScorableRun, ScoreResult, Scorer } from './types.js';

let live: LiveScoring | undefined;

afterEach(() => {
  live?.dispose();
  live = undefined;
});

function run(overrides: Partial<ScorableRun> & { runId: string }): ScorableRun {
  return {
    threadId: 'thread-1',
    actorRef: 'alice',
    agentName: 'ops',
    status: 'completed',
    input: 'how many pods are down?',
    output: 'two',
    toolCalls: [],
    durationMs: 10,
    errorCode: null,
    startedAt: '2026-09-01T10:00:00.000Z',
    ...overrides,
  };
}

function finish(runId: string): void {
  publishAgentRunFinished({
    runId,
    threadId: 'thread-1',
    steps: 1,
    inputTokens: 1,
    outputTokens: 1,
  });
}

class ExplodingScorer implements Scorer {
  readonly name = 'exploding';
  readonly kind = 'rule' as const;
  async score(): Promise<ScoreResult | null> {
    throw new Error('scorer blew up');
  }
}

describe('attachLiveScoring', () => {
  it('scores a run when it finishes and persists the verdict', async () => {
    const store = new InMemoryScoreStore();
    live = attachLiveScoring({
      source: new StaticRunSampleSource([run({ runId: 'r1' })]),
      scorers: [new RunCompletionScorer()],
      store,
    });

    finish('r1');
    await live.settled();

    expect((await store.listScores({})).map((row) => row.runId)).toEqual(['r1']);
  });

  it('scores nothing once disposed', async () => {
    const store = new InMemoryScoreStore();
    live = attachLiveScoring({
      source: new StaticRunSampleSource([run({ runId: 'r1' })]),
      scorers: [new RunCompletionScorer()],
      store,
    });
    live.dispose();

    finish('r1');
    await live.settled();

    expect(await store.listScores({})).toEqual([]);
  });

  it('reports a scorer failure to onError and never back to the publisher', async () => {
    const store = new InMemoryScoreStore();
    const errors: unknown[] = [];
    live = attachLiveScoring({
      source: new StaticRunSampleSource([run({ runId: 'r1' })]),
      scorers: [new ExplodingScorer()],
      store,
      onError: (error) => errors.push(error),
    });

    expect(() => finish('r1')).not.toThrow();
    await live.settled();

    expect((errors[0] as Error).message).toBe('scorer blew up');
    expect(await store.listScores({})).toEqual([]);
  });

  it('never asks the source about a malformed envelope', async () => {
    const asked: unknown[] = [];
    live = attachLiveScoring({
      source: {
        listRuns: async () => [],
        getRun: async (runId) => {
          asked.push(runId);
          return null;
        },
      },
      scorers: [new RunCompletionScorer()],
      store: new InMemoryScoreStore(),
    });

    // `emit` swallows subscriber throws, so publishing straight onto the channel is the only way
    // to see what the handler itself does with a shape the typed publisher would never produce.
    channel('aviary:agent:run.finished').publish(undefined);
    channel('aviary:agent:run.finished').publish({ payload: { runId: 42 } });
    await live.settled();

    expect(asked).toEqual([]);
  });

  it('catches an envelope that throws while being read, on the publisher’s own stack', async () => {
    const errors: unknown[] = [];
    live = attachLiveScoring({
      source: new StaticRunSampleSource([run({ runId: 'r1' })]),
      scorers: [new RunCompletionScorer()],
      store: new InMemoryScoreStore(),
      onError: (error) => errors.push(error),
    });

    channel('aviary:agent:run.finished').publish({
      get payload(): never {
        throw new Error('exploding envelope');
      },
    });

    // Reported, not raised: an unguarded handler would leave this to Node's uncaught-exception
    // path, since `Channel.publish` re-throws a subscriber's error on the next tick.
    expect((errors[0] as Error).message).toBe('exploding envelope');
  });

  it('ignores a run the source no longer has', async () => {
    const store = new InMemoryScoreStore();
    const errors: unknown[] = [];
    live = attachLiveScoring({
      source: new StaticRunSampleSource([]),
      scorers: [new RunCompletionScorer()],
      store,
      onError: (error) => errors.push(error),
    });

    finish('gone');
    await live.settled();

    expect(await store.listScores({})).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('sheds runs below the sample rate', async () => {
    const store = new InMemoryScoreStore();
    const draws = [0.9, 0.1];
    live = attachLiveScoring({
      source: new StaticRunSampleSource([run({ runId: 'r1' }), run({ runId: 'r2' })]),
      scorers: [new RunCompletionScorer()],
      store,
      sampleRate: 0.5,
      random: () => draws.shift() ?? 0,
    });

    finish('r1');
    finish('r2');
    await live.settled();

    expect((await store.listScores({})).map((row) => row.runId)).toEqual(['r2']);
  });

  it('does not let a store that rejects escape the subscriber', async () => {
    const errors: unknown[] = [];
    live = attachLiveScoring({
      source: new StaticRunSampleSource([run({ runId: 'r1' })]),
      scorers: [new RunCompletionScorer()],
      store: {
        recordScores: async () => {
          throw new Error('score store down');
        },
        scoredRunIds: async () => [],
        listScores: async () => [],
      },
      onError: (error) => errors.push(error),
    });

    finish('r1');
    await expect(live.settled()).resolves.toBeUndefined();

    expect((errors[0] as Error).message).toBe('score store down');
  });
});
