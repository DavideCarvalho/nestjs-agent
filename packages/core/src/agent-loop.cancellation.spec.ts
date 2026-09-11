import {
  FakeModelProvider,
  type FakeScript,
  InMemoryAgentStore,
  InMemoryTokenStreamSink,
} from '@dudousxd/nestjs-agent-testing';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  type AgentLoopDeps,
  type AgentLoopHooks,
  DefaultRolesPolicy,
  RunCancelledError,
  ToolRegistry,
  agentFailureCode,
  runAgentLoop,
} from './index.js';

const RUN_ID = 'run-1';
const ACTOR = { id: 'u1', roles: ['ADMIN'] };

/**
 * The durable engine's replay contract, reduced to what this file needs — the same fake journal the
 * other replay suites use: checkpoints are positional, outputs round-trip through JSON, and a name
 * that disagrees with the one recorded at that position is a NonDeterminismError.
 */
class Journal {
  private readonly entries: Array<{ name: string; output: string | undefined }> = [];
  private seq = 0;

  rewind(): void {
    this.seq = 0;
  }

  names(): string[] {
    return this.entries.map((entry) => entry.name);
  }

  async at<T>(name: string, produce: () => Promise<T>): Promise<T> {
    const position = this.seq;
    this.seq += 1;
    const existing = this.entries[position];
    if (existing !== undefined) {
      if (existing.name !== name) {
        const refusal = new Error(
          `non-determinism at ${RUN_ID}#${position}: code expects "${name}" but history recorded "${existing.name}"`,
        );
        refusal.name = 'NonDeterminismError';
        throw refusal;
      }
      return (existing.output === undefined ? undefined : JSON.parse(existing.output)) as T;
    }
    const output = await produce();
    const serialized = output === undefined ? undefined : JSON.stringify(output);
    this.entries[position] = { name, output: serialized };
    return (serialized === undefined ? undefined : JSON.parse(serialized)) as T;
  }
}

/** Two steps: one that calls a tool, one that answers. */
const callsThenAnswers: FakeScript = (_args, turnIndex) =>
  turnIndex === 0 ? { text: 'peeking', toolCall: { name: 'peek', input: {} } } : { text: 'done' };

interface RunOptions {
  script?: FakeScript;
  /** Answers the loop's cancel observation. Omit entirely to leave the hook unwired. */
  cancelled?: () => Promise<boolean>;
  patched?: (id: string) => Promise<boolean>;
  journal?: Journal;
  toolCalls?: string[];
}

async function run(options: RunOptions = {}) {
  const store = new InMemoryAgentStore();
  const sink = new InMemoryTokenStreamSink();
  const thread = await store.createThread({ actor: ACTOR });
  const registry = new ToolRegistry();
  const executed: string[] = [];
  registry.register(
    { name: 'peek', kind: 'read', description: 'peek', inputSchema: z.object({}) },
    {
      execute: async () => {
        executed.push('peek');
        return { seen: true };
      },
    },
  );
  let modelCalls = 0;
  const scripted = new FakeModelProvider(options.script ?? callsThenAnswers);
  const deps: AgentLoopDeps = {
    model: {
      runTurn: async (args) => {
        modelCalls += 1;
        return scripted.runTurn(args);
      },
    },
    store,
    registry,
    rolesPolicy: new DefaultRolesPolicy(),
    modelId: 'fake-1',
    day: '2026-06-30',
    systemPrompt: 'You are a test agent.',
  };
  const journal = options.journal;
  const stepNames: string[] = [];
  const hooks: AgentLoopHooks = {
    runId: RUN_ID,
    openSink: () => sink.open(RUN_ID),
    awaitApproval: async () => ({ approved: true }),
    step: (name, fn) => {
      stepNames.push(name);
      return journal === undefined ? fn() : journal.at(name, fn);
    },
    ...(options.cancelled !== undefined ? { cancelled: options.cancelled } : {}),
    ...(options.patched !== undefined ? { patched: options.patched } : {}),
  };
  journal?.rewind();
  const outcome = await runAgentLoop(
    deps,
    { threadId: thread.id, actor: ACTOR, userText: 'hi' },
    hooks,
  ).then(
    (result) => ({ result, error: undefined }),
    (error: unknown) => ({ result: undefined, error }),
  );
  return {
    outcome,
    stepNames,
    executed,
    modelCalls,
    store,
    messages: (await store.getThread(thread.id))?.messages ?? [],
  };
}

describe('a run that observes a cancel', () => {
  it('stops before the next model call and unwinds instead of finishing', async () => {
    // False on the first step's two observations, true from then on — a Stop pressed while the
    // turn's tool was executing.
    let seen = 0;
    const { outcome, modelCalls, executed } = await run({
      cancelled: async () => {
        seen += 1;
        return seen > 2;
      },
    });
    expect(outcome.error).toBeInstanceOf(RunCancelledError);
    // One model call, its tool, and then nothing: the second step never happened.
    expect(modelCalls).toBe(1);
    expect(executed).toEqual(['peek']);
  });

  it('stops before dispatching the turn’s tools when the cancel lands during the model call', async () => {
    const { outcome, executed, modelCalls } = await run({
      // Step 0's between-steps check is the first; its pre-tool check is the second.
      cancelled: (() => {
        let seen = 0;
        return async () => {
          seen += 1;
          return seen > 1;
        };
      })(),
    });
    expect(outcome.error).toBeInstanceOf(RunCancelledError);
    expect(modelCalls).toBe(1);
    expect(executed).toEqual([]);
  });

  it('never reaches the model at all when the cancel is already in when the loop starts', async () => {
    const { outcome, modelCalls } = await run({ cancelled: async () => true });
    expect(outcome.error).toBeInstanceOf(RunCancelledError);
    expect(modelCalls).toBe(0);
  });

  it('leaves the run unsettled for its runner — it records no completion of its own', async () => {
    const { stepNames } = await run({ cancelled: async () => true });
    expect(stepNames).not.toContain('persist:run:end');
    expect(stepNames).not.toContain('persist:title');
  });

  it('is not a failure — the failure code says cancelled, not run_failed', () => {
    expect(agentFailureCode(new RunCancelledError())).toBe('cancelled');
    expect(agentFailureCode(new Error('boom'))).toBe('run_failed');
  });
});

describe('the cancel observation and the journal', () => {
  it('reads a recorded answer back rather than asking again, so a replay cannot diverge', async () => {
    const journal = new Journal();
    // Pass 1 runs to completion with nothing cancelled — every observation is journaled `false`.
    const first = await run({ journal, cancelled: async () => false });
    expect(first.outcome.error).toBeUndefined();
    const recorded = journal.names();

    // Pass 2 is the same run replaying AFTER a cancel arrived. Every position it lands on is one
    // the history already holds, so the recorded `false` is what it reads — the replay follows the
    // path it took before instead of unwinding half way through someone else's journal.
    const second = await run({
      journal,
      cancelled: async () => true,
      script: () => {
        throw new Error('the replay must not reach the model');
      },
    });
    expect(second.outcome.error).toBeUndefined();
    expect(journal.names()).toEqual(recorded);
  });

  it('takes its observation at exactly two positions per step', async () => {
    const journal = new Journal();
    await run({ journal, cancelled: async () => false });
    expect(journal.names()).toEqual([
      'persist:user',
      'load:thread',
      'run:started-at',
      'persist:run:start',
      'cancel:check:0',
      'stream:step-start:0',
      'llm:0',
      'persist:usage:0',
      'persist:assistant:0',
      'cancel:tools:0',
      'persist:toolcall:call-0-peek',
      'tool:call-0-peek',
      'persist:toolexec:call-0-peek',
      'stream:tool-outputs:0',
      'stream:step-finish:0',
      'cancel:check:1',
      'stream:step-start:1',
      'llm:1',
      'persist:usage:1',
      'persist:assistant:1',
      // The final step answers with no tool calls, so there is nothing to hold back before.
      'stream:step-finish:1',
      'persist:title',
      'persist:run:end',
    ]);
  });

  it('adds no position at all to a runner that wired no cancel', async () => {
    const journal = new Journal();
    await run({ journal });
    expect(journal.names().some((name) => name.startsWith('cancel:'))).toBe(false);
  });

  it('keeps a run that predates the shape replaying against the shape it recorded', async () => {
    const journal = new Journal();
    // `patched` answering false is how the durable runtime says "this run started before the
    // positions existed" — it must then take none of them, whatever the hook would answer.
    const { outcome } = await run({
      journal,
      cancelled: async () => true,
      patched: async () => false,
    });
    expect(outcome.error).toBeUndefined();
    expect(journal.names().some((name) => name.startsWith('cancel:'))).toBe(false);
  });
});
