import {
  FakeModelProvider,
  InMemoryAgentStore,
  InMemoryTokenStreamSink,
} from '@dudousxd/nestjs-agent-testing';
import { describe, expect, it } from 'vitest';
import {
  type AgentLoopDeps,
  type AgentLoopHooks,
  type AgentStore,
  DefaultRolesPolicy,
  type HistoryPolicy,
  type ModelMessage,
  type RecordUsageInput,
  ToolRegistry,
  runAgentLoop,
  windowHistory,
} from './index.js';

const RUN_ID = 'run-1';

/** An in-memory store that also keeps each usage call's input, in the order the turn made them. */
class RecordingStore extends InMemoryAgentStore {
  readonly usageInputs: RecordUsageInput[] = [];

  override async recordUsage(input: RecordUsageInput): Promise<void> {
    this.usageInputs.push(input);
    await super.recordUsage(input);
  }
}

interface RunResult {
  /** The `messages` each model turn was actually given — what the ceiling is measured against. */
  turns: ModelMessage[][];
  stepNames: string[];
  usage: RecordUsageInput[];
}

/**
 * Run one turn against a thread pre-seeded with `priorMessages` earlier exchanges, capturing what
 * the model saw, which checkpoints were taken, and what usage was recorded.
 */
async function run(
  priorMessages: number,
  historyPolicy?: HistoryPolicy,
  step?: AgentLoopHooks['step'],
): Promise<RunResult> {
  const store = new RecordingStore();
  const sink = new InMemoryTokenStreamSink();
  const thread = await store.createThread({ actor: { id: 'u1', roles: ['ADMIN'] } });
  for (let index = 0; index < priorMessages; index += 1) {
    await store.appendMessage({
      threadId: thread.id,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `old-${index}`,
    });
  }

  const turns: ModelMessage[][] = [];

  const deps: AgentLoopDeps = {
    model: new FakeModelProvider((args) => {
      turns.push(args.messages.map((message) => ({ ...message })));
      return { text: 'answered' };
    }),
    store,
    registry: new ToolRegistry(),
    rolesPolicy: new DefaultRolesPolicy(),
    modelId: 'fake-1',
    day: '2026-06-30',
    systemPrompt: 'You are a test agent.',
    ...(historyPolicy !== undefined ? { historyPolicy } : {}),
  };
  const stepNames: string[] = [];
  const hooks: AgentLoopHooks = {
    runId: RUN_ID,
    openSink: () => sink.open(RUN_ID),
    awaitApproval: async () => ({ approved: true }),
    step: (name, fn) => {
      stepNames.push(name);
      return step !== undefined ? step(name, fn) : fn();
    },
  };
  await runAgentLoop(
    deps,
    { threadId: thread.id, actor: { id: 'u1', roles: ['ADMIN'] }, userText: 'hi' },
    hooks,
  );
  return { turns, stepNames, usage: store.usageInputs };
}

function contents(messages: ModelMessage[]): string[] {
  return messages.map((message) => message.content);
}

describe('agent loop — history ceiling', () => {
  it('sends the WHOLE thread and takes the same checkpoints when no policy is configured', async () => {
    const { turns, stepNames } = await run(6);
    expect(contents(turns[0] ?? [])).toEqual([
      'old-0',
      'old-1',
      'old-2',
      'old-3',
      'old-4',
      'old-5',
      'hi',
    ]);
    // The checkpoint list an in-flight run replays against. A policy must not add to, rename, or
    // reorder any of it — a resumed run that predates the config would land on a position the
    // history cannot supply.
    expect(stepNames).toEqual([
      'persist:user',
      'load:thread',
      'run:prompt-stages',
      'run:started-at',
      'persist:run:start',
      'stream:step-start:0',
      'llm:0',
      'persist:usage:0',
      'persist:assistant:0',
      'stream:step-finish:0',
      'persist:title',
      'persist:run:end',
    ]);
  });

  it('a window trims the turn to the newest messages and takes no extra checkpoint', async () => {
    const unbounded = await run(6);
    const windowed = await run(6, windowHistory({ maxMessages: 3 }));
    expect(contents(windowed.turns[0] ?? [])).toEqual(['old-4', 'old-5', 'hi']);
    // Selection is pure, so it needs no checkpoint of its own — the list is byte-identical to the
    // unconfigured run's.
    expect(windowed.stepNames).toEqual(unbounded.stepNames);
  });

  it('folds the dropped messages into a leading system summary, inside a checkpoint', async () => {
    let dropped: ModelMessage[] = [];
    const policy = windowHistory({
      maxMessages: 2,
      summarize: async (messages) => {
        dropped = messages;
        return { text: 'they said hello a lot' };
      },
    });
    const { turns, stepNames } = await run(6, policy);
    expect(contents(dropped)).toEqual(['old-0', 'old-1', 'old-2', 'old-3', 'old-4']);
    const sent = turns[0] ?? [];
    expect(sent[0]?.role).toBe('system');
    expect(sent[0]?.content).toContain('they said hello a lot');
    expect(contents(sent).slice(1)).toEqual(['old-5', 'hi']);
    // Summarizing calls a model, so it MUST be journaled — and it lands after the thread loads,
    // before anything that streams.
    expect(stepNames.indexOf('history:summarize')).toBe(stepNames.indexOf('load:thread') + 1);
  });

  it('a replay reads the summary back from its checkpoint instead of summarizing again', async () => {
    let calls = 0;
    const policy = windowHistory({
      maxMessages: 2,
      summarize: async () => {
        calls += 1;
        return { text: `summary #${calls}` };
      },
    });
    // The replay contract for this one checkpoint: the first pass runs the body and records what it
    // returned; a later pass returns the record without running it. Round-tripped through JSON, like
    // a real journal's entries. Every other step still executes, so the second run reaches the model
    // and we can see which summary it was prompted with.
    let recorded: string | undefined;
    const replayStep: AgentLoopHooks['step'] = async (name, fn) => {
      if (name !== 'history:summarize') {
        return fn();
      }
      if (recorded !== undefined) {
        return JSON.parse(recorded) as never;
      }
      const value = await fn();
      recorded = JSON.stringify(value);
      return value;
    };
    const first = await run(6, policy, replayStep);
    const second = await run(6, policy, replayStep);
    expect(calls).toBe(1);
    expect(first.turns[0]?.[0]?.content).toContain('summary #1');
    expect(second.turns[0]?.[0]?.content).toContain('summary #1');
  });

  it('records the summarizer’s own spend as a `history_summary` usage row', async () => {
    const policy = windowHistory({
      maxMessages: 2,
      summarize: async () => ({
        text: 'a summary',
        usage: { inputTokens: 900, outputTokens: 40 },
        modelId: 'summarizer-1',
      }),
    });
    const { usage, stepNames } = await run(6, policy);
    expect(usage).toContainEqual({
      threadId: expect.any(String),
      actorRef: 'u1',
      modelId: 'summarizer-1',
      purpose: 'history_summary',
      usage: { inputTokens: 900, outputTokens: 40 },
    });
    expect(stepNames).toContain('persist:usage:history');
  });

  it('skips both extra checkpoints when the summarizer reports no usage', async () => {
    const policy = windowHistory({
      maxMessages: 2,
      summarize: async () => ({ text: 'free of charge' }),
    });
    const { usage, stepNames } = await run(6, policy);
    expect(usage.map((row) => row.purpose)).toEqual(['chat']);
    expect(stepNames).not.toContain('persist:usage:history');
  });

  it('never summarizes when the window dropped nothing', async () => {
    let calls = 0;
    const policy = windowHistory({
      maxMessages: 50,
      summarize: async () => {
        calls += 1;
        return { text: 'unused' };
      },
    });
    const { stepNames } = await run(3, policy);
    expect(calls).toBe(0);
    expect(stepNames).not.toContain('history:summarize');
  });

  it('passes the turn’s thread, actor and agent to the policy', async () => {
    const seen: unknown[] = [];
    const policy: HistoryPolicy = {
      select: (messages, ctx) => {
        seen.push(ctx);
        return { keep: messages, drop: [] };
      },
    };
    await run(2, policy);
    expect(seen).toEqual([{ threadId: expect.any(String), actor: { id: 'u1', roles: ['ADMIN'] } }]);
  });
});
