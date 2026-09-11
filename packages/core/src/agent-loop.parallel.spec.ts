import { InMemoryAgentStore, InMemoryTokenStreamSink } from '@dudousxd/nestjs-agent-testing';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  type AgentLoopDeps,
  type AgentLoopHooks,
  DefaultRolesPolicy,
  type ModelProvider,
  type ModelTurnArgs,
  type ModelTurnResult,
  ToolRegistry,
  runAgentLoop,
  settleAll,
} from './index.js';

const RUN_ID = 'run-1';
const ACTOR = { id: 'u1', roles: ['ADMIN'] };
/** What the durable runner's dispatched tool step is CALLED — one routing name for every call. */
const DISPATCH_NAME = 'agent.tool';

/**
 * The durable engine's replay contract, reduced to what this file needs: positions are handed out
 * on the CALL, a name that disagrees with the one recorded at that position is a
 * NonDeterminismError, and outputs round-trip through JSON like the real store's do. Modelled on
 * `agent-loop.replay.spec.ts`'s journal, plus the two things concurrency needs: a position is
 * RESERVED before its body runs (so a body that suspends leaves the position spent, exactly as a
 * dispatched step's `pending` checkpoint does), and `patched` — the version gate — is here too.
 */
class Journal {
  private readonly entries: Array<{ name: string; done: boolean; output: string | undefined }> = [];
  private seq = 0;

  rewind(): void {
    this.seq = 0;
  }

  names(): string[] {
    return this.entries.map((entry) => entry.name);
  }

  /** The recorded names from where the turn's tool block begins — the part under test. */
  toolNames(): string[] {
    const names = this.names();
    const start = names.findIndex(
      (name) => name.startsWith('persist:toolcall:') || name === 'patch:agent:parallel-tools',
    );
    return start === -1 ? [] : names.slice(start);
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
      if (existing.done) {
        return (existing.output === undefined ? undefined : JSON.parse(existing.output)) as T;
      }
    } else {
      this.entries[position] = { name, done: false, output: undefined };
    }
    const output = await produce();
    const serialized = output === undefined ? undefined : JSON.stringify(output);
    this.entries[position] = { name, done: true, output: serialized };
    return (serialized === undefined ? undefined : JSON.parse(serialized)) as T;
  }

  /** `ctx.patched`: consume a position for a run that first arrives here, give it back otherwise. */
  async patched(id: string): Promise<boolean> {
    const marker = `patch:${id}`;
    const position = this.seq;
    this.seq += 1;
    const existing = this.entries[position];
    if (existing !== undefined) {
      if (existing.name === marker) return true;
      this.seq -= 1;
      return false;
    }
    this.entries[position] = { name: marker, done: true, output: 'true' };
    return true;
  }
}

/** Asks for every one of `calls` in ONE turn, then finishes — what a model routinely does. */
class MultiToolModel implements ModelProvider {
  constructor(private readonly calls: { id: string; name: string }[]) {}

  async runTurn(args: ModelTurnArgs): Promise<ModelTurnResult> {
    const turnIndex = args.messages.filter((message) => message.role === 'assistant').length;
    const text = turnIndex === 0 ? 'looking' : 'done';
    await args.sink.write(new TextEncoder().encode(text));
    return {
      text,
      toolCalls: turnIndex === 0 ? this.calls.map((call) => ({ ...call, input: {} })) : [],
      usage: { inputTokens: args.messages.length, outputTokens: text.length },
    };
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function withDeadline<T>(work: Promise<T>, message: string): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error(message)), 1000).unref?.();
    }),
  ]);
}

interface ToolSpec {
  kind?: 'read' | 'action';
  execute: () => Promise<unknown>;
}

function registryOf(tools: Record<string, ToolSpec>): ToolRegistry {
  const registry = new ToolRegistry();
  for (const [name, tool] of Object.entries(tools)) {
    registry.register(
      { name, kind: tool.kind ?? 'read', description: name, inputSchema: z.object({}) },
      { execute: tool.execute },
    );
  }
  return registry;
}

interface PassOptions {
  journal: Journal;
  tools: Record<string, ToolSpec>;
  calls: { id: string; name: string }[];
  /** Off = the loop must run the turn's calls one at a time, exactly as it always has. */
  concurrent?: boolean;
  /** On = the durable shape: one routing name for every tool call, on a routed step. */
  dispatched?: boolean;
}

interface PassResult {
  text: string;
  /** Every settled tool call, as the loop persisted it — the call id paired with its output. */
  settled: { id: string; output: unknown }[];
}

async function pass(options: PassOptions): Promise<PassResult> {
  const { journal, tools, calls } = options;
  const store = new InMemoryAgentStore();
  const settled: { id: string; output: unknown }[] = [];
  const record = store.updateToolCall.bind(store);
  store.updateToolCall = async (update) => {
    settled.push({ id: update.toolCallId, output: update.output });
    await record(update);
  };
  const sink = new InMemoryTokenStreamSink();
  const registry = registryOf(tools);
  const thread = await store.createThread({ actor: ACTOR });
  const deps: AgentLoopDeps = {
    model: new MultiToolModel(calls),
    store,
    registry,
    rolesPolicy: new DefaultRolesPolicy(),
    modelId: 'fake-1',
    day: '2026-06-30',
    systemPrompt: 'You are a test agent.',
  };
  const hooks: AgentLoopHooks = {
    runId: RUN_ID,
    openSink: () => sink.open(RUN_ID),
    awaitApproval: (call) =>
      journal.at(`signal:tool:${RUN_ID}:${call.id}`, async () => ({ approved: true })),
    step: (name, fn) => journal.at(name, () => fn()),
    // The version gate belongs to the journal, not to the concurrency: the durable runner wires it
    // whether or not this deployment can overlap anything.
    patched: (id) => journal.patched(id),
    ...(options.concurrent === true ? { parallel: settleAll } : {}),
    ...(options.dispatched === true
      ? {
          dispatchTool: (call, envelope) =>
            journal.at(DISPATCH_NAME, () =>
              registry.invoke(call.name, envelope.input, envelope.ctx, deps.rolesPolicy),
            ),
        }
      : {}),
  };
  journal.rewind();
  const result = await runAgentLoop(
    deps,
    { threadId: thread.id, actor: ACTOR, userText: 'hi' },
    hooks,
  );
  return { text: result.text, settled };
}

describe('agent loop — concurrent tool calls', () => {
  it('overlaps a turn whose calls are all reads', async () => {
    const alphaStarted = deferred();
    const betaStarted = deferred();
    await withDeadline(
      pass({
        journal: new Journal(),
        concurrent: true,
        calls: [
          { id: 'call-a', name: 'alpha' },
          { id: 'call-b', name: 'beta' },
        ],
        tools: {
          // Each tool blocks until the OTHER has started, so this turn can only finish if the two
          // invocations are in flight at the same time.
          alpha: {
            execute: async () => {
              alphaStarted.resolve();
              await betaStarted.promise;
              return { from: 'alpha' };
            },
          },
          beta: {
            execute: async () => {
              betaStarted.resolve();
              await alphaStarted.promise;
              return { from: 'beta' };
            },
          },
        },
      }),
      'the turn never finished — the two read tools did not overlap',
    );
  });

  it('keeps every checkpoint in call order: claims, then invocations, then persists', async () => {
    const journal = new Journal();
    await pass({
      journal,
      concurrent: true,
      calls: [
        { id: 'call-a', name: 'alpha' },
        { id: 'call-b', name: 'beta' },
      ],
      tools: {
        // The FIRST call is the slow one, so every position it holds — its invocation and its
        // persist — is one a completion-ordered scheme would have given to `beta` instead.
        alpha: {
          execute: async () => {
            await new Promise((resolve) => setTimeout(resolve, 20));
            return { from: 'alpha' };
          },
        },
        beta: { execute: async () => ({ from: 'beta' }) },
      },
    });

    expect(journal.toolNames().slice(0, 7)).toEqual([
      'patch:agent:parallel-tools',
      'persist:toolcall:call-a',
      'persist:toolcall:call-b',
      'tool:call-a',
      'tool:call-b',
      'persist:toolexec:call-a',
      'persist:toolexec:call-b',
    ]);
  });

  it('replays a suspended turn onto the same positions and the same per-call outputs', async () => {
    const journal = new Journal();
    const suspend = Object.assign(new Error('suspended'), {
      [Symbol.for('aviary:durable:control-flow')]: true,
    });
    let suspendOnce = true;
    const tools: Record<string, ToolSpec> = {
      alpha: { execute: async () => ({ from: 'alpha' }) },
      // Suspends the first time it is reached — a dispatched step handing the turn back to the
      // engine — and completes on the resume.
      beta: {
        execute: async () => {
          if (suspendOnce) {
            suspendOnce = false;
            throw suspend;
          }
          return { from: 'beta' };
        },
      },
    };
    const calls = [
      { id: 'call-a', name: 'alpha' },
      { id: 'call-b', name: 'beta' },
    ];

    await expect(pass({ journal, tools, calls, concurrent: true, dispatched: true })).rejects.toBe(
      suspend,
    );
    // Nothing was persisted for the sibling that DID finish: its `persist:toolexec` would sit at the
    // position the resume computes for call-a's, and the outputs would swap.
    expect(journal.names()).not.toContain('persist:toolexec:call-a');

    const resumed = await pass({ journal, tools, calls, concurrent: true, dispatched: true });
    expect(resumed.text).toBe('done');
    // Two dispatched calls share ONE checkpoint name, so a swapped pair of positions raises no
    // refusal at all — it hands one call's output to the other. Pin the pairing.
    expect(resumed.settled).toEqual([
      { id: 'call-a', output: { from: 'alpha' } },
      { id: 'call-b', output: { from: 'beta' } },
    ]);
    expect(journal.toolNames().slice(0, 7)).toEqual([
      'patch:agent:parallel-tools',
      'persist:toolcall:call-a',
      'persist:toolcall:call-b',
      DISPATCH_NAME,
      DISPATCH_NAME,
      'persist:toolexec:call-a',
      'persist:toolexec:call-b',
    ]);
  });

  it('runs the calls one at a time when the runner offers no deterministic concurrency', async () => {
    const journal = new Journal();
    await pass({
      journal,
      calls: [
        { id: 'call-a', name: 'alpha' },
        { id: 'call-b', name: 'beta' },
      ],
      tools: {
        alpha: { execute: async () => ({ from: 'alpha' }) },
        beta: { execute: async () => ({ from: 'beta' }) },
      },
    });

    expect(journal.toolNames().slice(0, 6)).toEqual([
      'persist:toolcall:call-a',
      'tool:call-a',
      'persist:toolexec:call-a',
      'persist:toolcall:call-b',
      'tool:call-b',
      'persist:toolexec:call-b',
    ]);
  });

  it('leaves a single-call turn on the checkpoint sequence it always had', async () => {
    const journal = new Journal();
    await pass({
      journal,
      concurrent: true,
      calls: [{ id: 'call-a', name: 'alpha' }],
      tools: { alpha: { execute: async () => ({ from: 'alpha' }) } },
    });

    expect(journal.toolNames().slice(0, 3)).toEqual([
      'persist:toolcall:call-a',
      'tool:call-a',
      'persist:toolexec:call-a',
    ]);
  });

  it('runs a turn containing an action sequentially, approval and execution per call', async () => {
    const journal = new Journal();
    await pass({
      journal,
      concurrent: true,
      calls: [
        { id: 'call-a', name: 'alpha' },
        { id: 'call-b', name: 'purge' },
      ],
      tools: {
        alpha: { execute: async () => ({ from: 'alpha' }) },
        purge: { kind: 'action', execute: async () => ({ purged: true }) },
      },
    });

    expect(journal.toolNames().slice(0, 8)).toEqual([
      'patch:agent:parallel-tools',
      'persist:toolcall:call-a',
      'persist:toolcall:call-b',
      'tool:call-a',
      'persist:toolexec:call-a',
      `signal:tool:${RUN_ID}:call-b`,
      'tool:call-b',
      'persist:toolexec:call-b',
    ]);
  });

  it('keeps replaying a run that recorded the sequential shape before the batched one existed', async () => {
    const journal = new Journal();
    const tools = {
      alpha: { execute: async () => ({ from: 'alpha' }) },
      beta: { execute: async () => ({ from: 'beta' }) },
    };
    const calls = [
      { id: 'call-a', name: 'alpha' },
      { id: 'call-b', name: 'beta' },
    ];

    // Recorded by a process that had no concurrency hooks at all.
    await pass({ journal, tools, calls });
    const recorded = journal.names();

    // Resumed by one that has them: the version gate must give the position back.
    const resumed = await pass({ journal, tools, calls, concurrent: true });
    expect(resumed.text).toBe('done');
    expect(journal.names()).toEqual(recorded);
  });

  it('records one call as failed without touching its concurrent sibling', async () => {
    const journal = new Journal();
    const run = await pass({
      journal,
      concurrent: true,
      calls: [
        { id: 'call-a', name: 'alpha' },
        { id: 'call-b', name: 'beta' },
      ],
      tools: {
        alpha: {
          execute: async () => {
            throw new Error('alpha blew up');
          },
        },
        beta: { execute: async () => ({ from: 'beta' }) },
      },
    });

    expect(run.text).toBe('done');
    expect(journal.toolNames().slice(0, 7)).toEqual([
      'patch:agent:parallel-tools',
      'persist:toolcall:call-a',
      'persist:toolcall:call-b',
      'tool:call-a',
      'tool:call-b',
      'persist:toolfail:call-a',
      'persist:toolexec:call-b',
    ]);
  });
});
