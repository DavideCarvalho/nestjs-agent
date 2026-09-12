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
  ToolRegistry,
  runAgentLoop,
} from './index.js';

const RUN_ID = 'run-1';
const CALL_ID = 'call-0-purgeCache';

/**
 * The durable engine's replay contract, reduced to what this file needs: checkpoints are positional,
 * and a name that disagrees with the one recorded at that position is a NonDeterminismError. Outputs
 * round-trip through JSON like the real store's do, so nothing can pass between the two passes
 * except what a checkpoint could actually carry.
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

  /** Corrupt one recorded name, to force a divergence at a position of the test's choosing. */
  renameAt(position: number, name: string): void {
    const entry = this.entries[position];
    if (entry === undefined) throw new Error(`no entry at ${position}`);
    entry.name = name;
  }

  async at<T>(name: string, produce: () => Promise<T>): Promise<T> {
    const position = this.seq;
    this.seq += 1;
    const existing = this.entries[position];
    if (existing !== undefined) {
      if (existing.name !== name) {
        // The engine's own class, reproduced by NAME — that is what `isReplayIntegrityError` keys
        // off, and what a thin worker would raise under the other spelling.
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

function registryWithPurgeCache(): ToolRegistry {
  const reg = new ToolRegistry();
  reg.register(
    { name: 'purgeCache', kind: 'action', description: 'purge', inputSchema: z.object({}) },
    { execute: async () => ({ purged: true }) },
  );
  return reg;
}

const script: FakeScript = (_args, turnIndex) =>
  turnIndex === 0
    ? { text: 'purging', toolCall: { name: 'purgeCache', input: {} } }
    : { text: 'done' };

async function pass(
  journal: Journal,
  registry: ToolRegistry,
  extra: Partial<AgentLoopDeps> = {},
): Promise<void> {
  const store = new InMemoryAgentStore();
  const sink = new InMemoryTokenStreamSink();
  const thread = await store.createThread({ actor: { id: 'u1', roles: ['ADMIN'] } });
  const deps: AgentLoopDeps = {
    model: new FakeModelProvider(script),
    store,
    registry,
    rolesPolicy: new DefaultRolesPolicy(),
    modelId: 'fake-1',
    day: '2026-06-30',
    systemPrompt: 'You are a test agent.',
    ...extra,
  };
  const hooks: AgentLoopHooks = {
    runId: RUN_ID,
    openSink: () => sink.open(RUN_ID),
    // The durable runner suspends here on `signal:tool:<runId>:<callId>`; the journal entry it
    // leaves behind is what a later replay has to line up with.
    awaitApproval: (call) =>
      journal.at(`signal:tool:${RUN_ID}:${call.id}`, async () => ({ approved: true })),
    step: (name, fn) => journal.at(name, () => fn()),
  };
  journal.rewind();
  await runAgentLoop(
    deps,
    { threadId: thread.id, actor: { id: 'u1', roles: ['ADMIN'] }, userText: 'hi' },
    hooks,
  );
}

describe('agent loop — replay across processes with different registries', () => {
  it('replays an action tool onto its approval signal even where the registry has no such tool', async () => {
    const journal = new Journal();

    // Pass 1: a process that HAS the action tool. It records the approval wait.
    await pass(journal, registryWithPurgeCache());
    const recorded = journal.names();
    // The shape the incident reported: the approval wait sits between the call's persist and the
    // execution step, so a replay that skips it lands `tool:` on the `signal:tool:` position.
    expect(recorded.slice(recorded.indexOf(`persist:toolcall:${CALL_ID}`))).toEqual([
      `persist:toolcall:${CALL_ID}`,
      `signal:tool:${RUN_ID}:${CALL_ID}`,
      `tool:${CALL_ID}`,
      `persist:toolexec:${CALL_ID}`,
      'stream:tool-outputs:0',
      'stream:step-finish:0',
      'stream:step-start:1',
      'llm:1',
      'persist:usage:1',
      'persist:assistant:1',
      'stream:step-finish:1',
      'persist:title',
      'persist:run:end',
    ]);

    // Pass 2: the same run resumes in a process whose registry is EMPTY — a module that never
    // declared the tool, a surface that mounts no tools, a pod still booting. Resolving the kind
    // locally reads `undefined`, falls back to 'read', and asks for a `tool:` checkpoint where the
    // history holds `signal:tool:` — the NonDeterminismError this guards against.
    await expect(pass(journal, new ToolRegistry())).resolves.toBeUndefined();
    expect(journal.names()).toEqual(recorded);
  });

  it('surfaces the checkpoint that actually diverged, not the one the failure path went on to ask for', async () => {
    const journal = new Journal();
    await pass(journal, registryWithPurgeCache());

    // Whatever the cause, once a position refuses, the tool `catch` must not answer with
    // `persist:toolfail:` at the NEXT position — that raises a second refusal naming two
    // checkpoints neither of which is the disagreement, which is what an operator ends up reading.
    const toolPosition = journal.names().indexOf(`tool:${CALL_ID}`);
    journal.renameAt(toolPosition, 'someOtherStep');

    await expect(pass(journal, registryWithPurgeCache())).rejects.toThrow(
      `non-determinism at ${RUN_ID}#${toolPosition}: code expects "tool:${CALL_ID}" but history recorded "someOtherStep"`,
    );
  });
});

describe('agent loop — checkpoint positions under processors and structured output', () => {
  it('leaves the sequence untouched for a run that configures neither', async () => {
    const journal = new Journal();
    await pass(journal, registryWithPurgeCache());
    // The list an in-flight run replays against. Nothing either feature adds may appear here.
    expect(journal.names()).toEqual([
      'persist:user',
      'load:thread',
      'run:prompt-stages',
      'run:started-at',
      'persist:run:start',
      'stream:step-start:0',
      'llm:0',
      'persist:usage:0',
      'persist:assistant:0',
      `persist:toolcall:${CALL_ID}`,
      `signal:tool:${RUN_ID}:${CALL_ID}`,
      `tool:${CALL_ID}`,
      `persist:toolexec:${CALL_ID}`,
      'stream:tool-outputs:0',
      'stream:step-finish:0',
      'stream:step-start:1',
      'llm:1',
      'persist:usage:1',
      'persist:assistant:1',
      'stream:step-finish:1',
      'persist:title',
      'persist:run:end',
    ]);
  });

  it('adds one position per step per feature, and replays onto exactly those positions', async () => {
    const journal = new Journal();
    const configured: Partial<AgentLoopDeps> = {
      inputProcessors: [{ name: 'tag', process: (prompt) => prompt }],
      outputProcessors: [{ name: 'pass', process: () => ({ action: 'pass' }) }],
      outputSchema: z.object({ ok: z.boolean() }),
    };
    await pass(journal, registryWithPurgeCache(), {
      ...configured,
      // The formatting pass needs a reply that satisfies the schema; the scripted fake answers prose.
      model: {
        runTurn: async (args) =>
          args.outputSchema !== undefined
            ? { text: '{"ok":true}', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } }
            : new FakeModelProvider(script).runTurn(args),
      },
    });
    const recorded = journal.names();
    expect(recorded.filter((name) => name.startsWith('process:input:'))).toEqual([
      'process:input:0',
      'process:input:1',
    ]);
    // The per-step gate on the streamed answer, plus the one the formatting pass takes on the
    // final step — the structured restatement is a second route out of the model, so it is ruled
    // on too (see `structureAnswer`).
    expect(recorded.filter((name) => name.startsWith('process:output:'))).toEqual([
      'process:output:0',
      'process:output:1',
      'process:output:structured:1:0',
    ]);
    // The formatting pass rides the FINAL step only, and its checkpoints sit between the gate and
    // the assistant persist — the same block a resume has to line up with.
    expect(recorded.slice(recorded.indexOf('process:output:1'))).toEqual([
      'process:output:1',
      'persist:usage:1',
      'structured:1:0',
      'persist:usage:structured:1:0',
      // After the attempt's usage row: the tokens were spent whatever the chain decides, so a
      // refusal can never hide its own cost.
      'process:output:structured:1:0',
      'persist:assistant:1',
      // Keyed by the assistant message's own id, which the replay reads back off
      // `persist:assistant:1` rather than minting a second one.
      expect.stringMatching(/^persist:structured:/),
      'stream:step-finish:1',
      'persist:title',
      'persist:run:end',
    ]);

    // A second process replaying the same run must land on every one of those positions. It gets a
    // model that would ANSWER DIFFERENTLY if it were ever asked, so a checkpoint silently re-run
    // would change the journal rather than pass unnoticed.
    await expect(
      pass(journal, registryWithPurgeCache(), {
        ...configured,
        model: {
          runTurn: async () => {
            throw new Error('the replay must not reach the model');
          },
        },
      }),
    ).resolves.toBeUndefined();
    expect(journal.names()).toEqual(recorded);
  });
});

describe('agent loop — checkpoint positions under retrieval and structured output', () => {
  /** A model that answers once with no tool calls, and satisfies a schema when asked for one. */
  const answering = {
    runTurn: async (args: { outputSchema?: unknown }) => ({
      text: args.outputSchema !== undefined ? '{"ok":true}' : 'grounded answer',
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 1 },
    }),
  };
  const passages = [{ id: 'doc#0', text: 'a passage', score: 1 }];

  it('records both synthetic calls under the message id the assistant persist minted', async () => {
    const journal = new Journal();
    const configured: Partial<AgentLoopDeps> = {
      model: answering,
      retriever: { retrieve: async () => passages },
      outputSchema: z.object({ ok: z.boolean() }),
    };
    await pass(journal, new ToolRegistry(), configured);
    const recorded = journal.names();

    expect(recorded).toEqual([
      'persist:user',
      'load:thread',
      'run:prompt-stages',
      'run:started-at',
      'persist:run:start',
      'retrieve',
      'stream:step-start:0',
      'llm:0',
      'persist:usage:0',
      'structured:0:0',
      'persist:usage:structured:0:0',
      'persist:assistant:0',
      // Both keyed by the assistant message's own id, read back off `persist:assistant:0` rather
      // than minted a second time — retrieval first, matching the order they ride the message in.
      expect.stringMatching(/^persist:retrieval:/),
      expect.stringMatching(/^persist:structured:/),
      'stream:step-finish:0',
      'persist:title',
      'persist:run:end',
    ]);

    // The resume runs against a FRESH store, so a message id recomputed locally would be a
    // different uuid and both names would refuse. It also gets a model and a retriever that would
    // throw if either were reached again.
    await expect(
      pass(journal, new ToolRegistry(), {
        ...configured,
        model: {
          runTurn: async () => {
            throw new Error('the replay must not reach the model');
          },
        },
        retriever: {
          retrieve: async () => {
            throw new Error('the replay must not reach the retriever');
          },
        },
      }),
    ).resolves.toBeUndefined();
    expect(journal.names()).toEqual(recorded);
  });
});
