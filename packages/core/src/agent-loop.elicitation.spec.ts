import {
  FakeModelProvider,
  type FakeScript,
  InMemoryAgentStore,
  InMemoryTokenStreamSink,
} from '@dudousxd/nestjs-agent-testing';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  type AgentIntake,
  type AgentLoopDeps,
  type AgentLoopHooks,
  DefaultRolesPolicy,
  type ElicitationReply,
  type ElicitationRequest,
  type HumanReply,
  ToolRegistry,
  decodeStreamEvent,
  runAgentLoop,
  settleAll,
} from './index.js';

const RUN_ID = 'run-1';
const ACTOR = { id: 'u1', roles: ['ADMIN'] };

/**
 * The durable engine's replay contract, reduced to what this file needs — the same fake journal
 * `agent-loop.replay.spec.ts` uses: checkpoints are positional, outputs round-trip through JSON, and
 * a name that disagrees with the one recorded at that position is a NonDeterminismError.
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

const INTAKE: AgentIntake = {
  questions: [
    {
      id: 'scope',
      prompt: 'How much should I cover?',
      options: [
        { value: 'file', label: 'This file', hotkey: 'a' },
        { value: 'module', label: 'The whole module', hotkey: 'b' },
      ],
      defaults: ['module'],
    },
  ],
};

const ASK_INPUT = {
  preamble: 'One question first.',
  questions: [
    {
      id: 'scope',
      prompt: 'How much should I cover?',
      options: [
        { value: 'file', label: 'This file' },
        { value: 'module', label: 'The whole module' },
      ],
      defaults: ['module'],
    },
  ],
};

/** A turn that answers in prose — nothing but the intake can park it. */
const plain: FakeScript = () => ({ text: 'done' });

/** A turn whose first step calls `ask`, then answers. */
const asks: FakeScript = (_args, turnIndex) =>
  turnIndex === 0
    ? { text: 'need scope', toolCall: { name: 'ask', input: ASK_INPUT } }
    : { text: 'done' };

interface PassOptions {
  extra?: Partial<AgentLoopDeps>;
  reply?: HumanReply;
  /** Omit `awaitAnswers` entirely, so the loop has to fall back to `awaitApproval`. */
  approvalOnly?: boolean;
  script?: FakeScript;
  store?: InMemoryAgentStore;
  threadId?: string;
  /** Arm the loop's batched tool path, which only exists for a runner that supplies it. */
  parallel?: boolean;
}

async function pass(
  journal: Journal,
  options: PassOptions = {},
): Promise<{
  store: InMemoryAgentStore;
  threadId: string;
  frames: unknown[];
  asked: ElicitationRequest[];
}> {
  const store = options.store ?? new InMemoryAgentStore();
  const sink = new InMemoryTokenStreamSink();
  const threadId = options.threadId ?? (await store.createThread({ actor: ACTOR })).id;
  const written: string[] = [];
  const decoder = new TextDecoder();
  const deps: AgentLoopDeps = {
    model: new FakeModelProvider(options.script ?? plain),
    store,
    registry: new ToolRegistry(),
    rolesPolicy: new DefaultRolesPolicy(),
    modelId: 'fake-1',
    day: '2026-06-30',
    systemPrompt: 'You are a test agent.',
    ...options.extra,
  };
  const asked: ElicitationRequest[] = [];
  const reply: HumanReply = options.reply ?? { answers: {} };
  const hooks: AgentLoopHooks = {
    runId: RUN_ID,
    openSink: async () => {
      const writer = await sink.open(RUN_ID);
      return {
        write: async (chunk: Uint8Array) => {
          written.push(decoder.decode(chunk));
          await writer.write(chunk);
        },
        end: () => writer.end(),
        fail: (error) => writer.fail(error),
      };
    },
    awaitApproval: (call) =>
      journal.at(`signal:tool:${RUN_ID}:${call.id}`, async () => ({ approved: true })),
    ...(options.approvalOnly === true
      ? {}
      : {
          awaitAnswers: (request) => {
            asked.push(request);
            return journal.at(`signal:tool:${RUN_ID}:${request.id}`, async () => reply);
          },
        }),
    step: (name, fn) => journal.at(name, () => fn()),
    ...(options.parallel === true ? { parallel: settleAll } : {}),
  };
  journal.rewind();
  await runAgentLoop(deps, { threadId, actor: ACTOR, userText: 'hi' }, hooks);
  const frames = written
    .flatMap((chunk) => chunk.split('\n'))
    .filter((line) => line.length > 0)
    .map((line) => decodeStreamEvent(line))
    .filter((event) => event !== null);
  return { store, threadId, frames, asked };
}

describe('configured intake — the checkpoints it adds, and to whom', () => {
  it('adds nothing at all to a turn that configures none', async () => {
    const journal = new Journal();
    await pass(journal);
    expect(journal.names()).toEqual([
      'persist:user',
      'load:thread',
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

  it('parks between the run bookkeeping and the first model call, on exactly three positions', async () => {
    const journal = new Journal();
    await pass(journal, { extra: { intake: INTAKE } });
    expect(journal.names()).toEqual([
      'persist:user',
      'load:thread',
      'run:started-at',
      'persist:run:start',
      // `intake:ask` carries the verdict AND the write, so a replay reads back whether the turn
      // asked rather than recomputing it against a thread the first attempt has since changed.
      'intake:ask',
      `signal:tool:${RUN_ID}:intake-${RUN_ID}`,
      'intake:answers',
      'stream:step-start:0',
      'llm:0',
      'persist:usage:0',
      'persist:assistant:0',
      'stream:step-finish:0',
      'persist:title',
      'persist:run:end',
    ]);
  });

  it('replays onto exactly those positions in a process that would answer differently', async () => {
    const journal = new Journal();
    await pass(journal, { extra: { intake: INTAKE } });
    const recorded = journal.names();
    // A second process resumes with a model that would throw if it were ever reached, and a reply
    // that would produce different answers if the wait were ever re-run.
    await expect(
      pass(journal, {
        extra: {
          intake: INTAKE,
          model: {
            runTurn: async () => {
              throw new Error('the replay must not reach the model');
            },
          },
        },
        reply: { answers: { scope: ['file'] } },
      }),
    ).resolves.toBeDefined();
    expect(journal.names()).toEqual(recorded);
  });

  it('asks once per thread by default, and every turn when told to', async () => {
    const wait = `signal:tool:${RUN_ID}:intake-${RUN_ID}`;
    const first = new Journal();
    const { store, threadId } = await pass(first, { extra: { intake: INTAKE } });
    expect(first.names()).toContain(wait);

    // The second turn still spends the `intake:ask` position — the verdict has to come out of the
    // journal, so the checkpoint that carries it is unconditional once an intake is configured —
    // but it does not park.
    const second = new Journal();
    await pass(second, { extra: { intake: INTAKE }, store, threadId });
    expect(second.names()).toContain('intake:ask');
    expect(second.names()).not.toContain(wait);

    const third = new Journal();
    await pass(third, {
      extra: { intake: { ...INTAKE, when: 'every-turn' } },
      store,
      threadId,
    });
    expect(third.names()).toContain(wait);
  });

  it('reads the verdict back off the journal instead of re-deciding it on the resume', async () => {
    // By the time a resume replays this turn, the first attempt has already appended the intake's
    // own assistant message to the thread — so a process that recomputed "has this thread been
    // asked?" would answer NO on the way in and YES on the way back, and land `stream:step-start:0`
    // where the history holds `signal:tool:`.
    const journal = new Journal();
    const { store, threadId } = await pass(journal, { extra: { intake: INTAKE } });
    const recorded = journal.names();
    expect((await store.getThread(threadId))?.messages.some((m) => m.role === 'assistant')).toBe(
      true,
    );
    await expect(
      pass(journal, { extra: { intake: INTAKE }, store, threadId }),
    ).resolves.toBeDefined();
    expect(journal.names()).toEqual(recorded);
  });

  it('costs no model call: the questions are authored, so nothing is generated or billed', async () => {
    const journal = new Journal();
    let calls = 0;
    const { store, threadId } = await pass(journal, {
      extra: {
        intake: INTAKE,
        model: {
          runTurn: async (args) => {
            calls += 1;
            return new FakeModelProvider(plain).runTurn(args);
          },
        },
      },
    });
    expect(calls).toBe(1);
    const usage = store.usageRows().map((row) => row.modelId);
    expect(usage).toHaveLength(1);
    expect(journal.names().filter((name) => name.startsWith('persist:usage'))).toEqual([
      'persist:usage:0',
    ]);
    expect(threadId).toBeDefined();
    expect(usage).toEqual(['fake-1']);
  });

  it('persists the question set as a pending tool call and settles it as executed', async () => {
    const journal = new Journal();
    const { store } = await pass(journal, {
      extra: { intake: INTAKE },
      reply: { answers: { scope: ['file'] } },
    });
    const [row] = store.toolCallRows();
    expect(row?.toolName).toBe('ask');
    expect(row?.toolType).toBe('action');
    expect(row?.status).toBe('executed');
    expect(row?.output).toMatchObject({ answers: { scope: ['file'] }, skipped: false });
  });

  it('records a skip as rejected, so it never reads as an answer the user gave', async () => {
    const journal = new Journal();
    const { store } = await pass(journal, {
      extra: { intake: INTAKE },
      reply: { answers: {}, skipped: true },
    });
    const [row] = store.toolCallRows();
    expect(row?.status).toBe('rejected');
    expect(row?.output).toMatchObject({ answers: { scope: ['module'] }, skipped: true });
  });

  it('streams the question set so a client can render it while the turn is parked', async () => {
    const journal = new Journal();
    const { frames } = await pass(journal, { extra: { intake: INTAKE } });
    const posted = frames.find(
      (frame): frame is { kind: 'elicitation'; id: string; request: ElicitationRequest } =>
        (frame as { kind: string }).kind === 'elicitation',
    );
    expect(posted?.request.source).toBe('intake');
    expect(posted?.request.questions).toHaveLength(1);
    expect(frames.some((frame) => (frame as { kind: string }).kind === 'tool-output')).toBe(true);
  });

  it('reads a bare approval as "the user confirmed the pre-picked answers"', async () => {
    const journal = new Journal();
    const { store } = await pass(journal, { extra: { intake: INTAKE }, approvalOnly: true });
    const [row] = store.toolCallRows();
    expect(row?.status).toBe('executed');
    expect(row?.output).toMatchObject({ answers: { scope: ['module'] }, defaulted: ['scope'] });
  });
});

describe('the model-callable ask — the same shape, the same resume path', () => {
  const askDeps: Partial<AgentLoopDeps> = { ask: true };

  it('offers the tool only where it is configured', async () => {
    const seen: string[][] = [];
    const spy = (base: Partial<AgentLoopDeps>): Partial<AgentLoopDeps> => ({
      ...base,
      model: {
        runTurn: async (args) => {
          seen.push(args.tools.map((tool) => tool.name));
          return { text: 'done', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
        },
      },
    });
    await pass(new Journal(), { extra: spy({}) });
    await pass(new Journal(), { extra: spy(askDeps) });
    expect(seen[0]).toEqual([]);
    expect(seen[1]).toEqual(['ask']);
  });

  it('parks on the SAME signal an approval uses, and reuses the approval persist names', async () => {
    const journal = new Journal();
    await pass(journal, { extra: askDeps, script: asks });
    const names = journal.names();
    expect(names.slice(names.indexOf('persist:toolcall:call-0-ask'))).toEqual([
      'persist:toolcall:call-0-ask',
      'stream:elicitation:call-0-ask',
      `signal:tool:${RUN_ID}:call-0-ask`,
      'persist:toolexec:call-0-ask',
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

  it('settles a skipped ask on the rejection position, not the execution one', async () => {
    const journal = new Journal();
    const { store } = await pass(journal, {
      extra: askDeps,
      script: asks,
      reply: { answers: {}, skipped: true },
    });
    expect(journal.names()).toContain('persist:toolreject:call-0-ask');
    expect(journal.names()).not.toContain('persist:toolexec:call-0-ask');
    const [row] = store.toolCallRows();
    expect(row?.status).toBe('rejected');
  });

  it('produces the same persisted shape as the configured intake', async () => {
    const viaAsk = await pass(new Journal(), { extra: askDeps, script: asks });
    const viaIntake = await pass(new Journal(), { extra: { intake: INTAKE } });
    const shape = (rows: { toolName: string; toolType: string; output?: unknown }[]) =>
      rows.map((row) => ({
        toolName: row.toolName,
        toolType: row.toolType,
        keys: Object.keys(row.output as object).sort(),
      }));
    expect(shape(viaAsk.store.toolCallRows())).toEqual(shape(viaIntake.store.toolCallRows()));
  });

  it('never asks the model a second time to produce the questions', async () => {
    let calls = 0;
    const journal = new Journal();
    await pass(journal, {
      extra: {
        ...askDeps,
        model: {
          runTurn: async (args) => {
            calls += 1;
            return new FakeModelProvider(asks).runTurn(args);
          },
        },
      },
    });
    // Two steps: the one that asked, and the one that answered. Nothing extra, and no
    // `persist:usage:*` row beyond the two `chat` ones those steps already record.
    expect(calls).toBe(2);
    expect(journal.names().filter((name) => name.startsWith('persist:usage'))).toEqual([
      'persist:usage:0',
      'persist:usage:1',
    ]);
  });

  it('hands a malformed question set back to the model as a tool failure', async () => {
    const journal = new Journal();
    const malformed: FakeScript = (_args, turnIndex) =>
      turnIndex === 0
        ? {
            text: 'asking',
            toolCall: {
              name: 'ask',
              // No `defaults` — the one thing the schema insists on.
              input: {
                questions: [
                  { id: 'scope', prompt: 'How much?', options: [{ value: 'a', label: 'A' }] },
                ],
              },
            },
          }
        : { text: 'done' };
    const { store } = await pass(journal, { extra: askDeps, script: malformed });
    expect(journal.names()).toContain('persist:toolfail:call-0-ask');
    expect(journal.names()).not.toContain(`signal:tool:${RUN_ID}:call-0-ask`);
    expect(store.toolCallRows()[0]?.error).toMatch(/pre-pick at least one option/);
  });

  it('replays an ask onto its wait even where nothing local knows the tool exists', async () => {
    const journal = new Journal();
    await pass(journal, { extra: askDeps, script: asks });
    const recorded = journal.names();
    // A process that does NOT have `ask` configured resumes the run. Deciding the kind locally
    // would read `read`, skip the wait, and land `persist:toolexec:` where the history holds
    // `stream:elicitation:` — the refusal this guards against.
    await expect(
      pass(journal, {
        extra: {
          model: {
            runTurn: async () => {
              throw new Error('the replay must not reach the model');
            },
          },
        },
        script: asks,
      }),
    ).resolves.toBeDefined();
    expect(journal.names()).toEqual(recorded);
  });
});

describe('an ask never rides the paths built for executable tools', () => {
  it('is not batched with the turn’s read tools', async () => {
    const registry = new ToolRegistry();
    registry.register(
      { name: 'peek', kind: 'read', description: 'peek', inputSchema: z.object({}) },
      { execute: async () => ({ seen: true }) },
    );
    const both: FakeScript = (_args, turnIndex) =>
      turnIndex === 0
        ? {
            text: 'both',
            toolCalls: [
              { name: 'peek', input: {} },
              { name: 'ask', input: ASK_INPUT },
            ],
          }
        : { text: 'done' };
    const journal = new Journal();
    // `parallel` present is what arms the batched path at all; without it there is nothing to
    // exclude an ask from.
    await pass(journal, { extra: { ask: true, registry }, script: both, parallel: true });
    const names = journal.names();
    // Batching overlaps the INVOCATIONS, which for an ask means handing it to the tool registry
    // that has never heard of it — a `persist:toolfail`, and no human ever asked.
    expect(names).toContain(`signal:tool:${RUN_ID}:call-0-ask`);
    expect(names).toContain('persist:toolexec:call-0-ask');
    expect(names).not.toContain('persist:toolfail:call-0-ask');
    expect(names).toContain('persist:toolexec:call-0-peek');
  });

  it('is never handed to a dispatched tool step', async () => {
    const journal = new Journal();
    const sink = new InMemoryTokenStreamSink();
    const store = new InMemoryAgentStore();
    const thread = await store.createThread({ actor: ACTOR });
    const dispatched: string[] = [];
    await runAgentLoop(
      {
        model: new FakeModelProvider(asks),
        store,
        registry: new ToolRegistry(),
        rolesPolicy: new DefaultRolesPolicy(),
        day: '2026-06-30',
        systemPrompt: 'x',
        ask: true,
      },
      { threadId: thread.id, actor: ACTOR, userText: 'hi' },
      {
        runId: RUN_ID,
        openSink: () => sink.open(RUN_ID),
        awaitApproval: async () => ({ approved: true }),
        awaitAnswers: (request) =>
          journal.at(`signal:tool:${RUN_ID}:${request.id}`, async () => ({ answers: {} })),
        step: (name, fn) => journal.at(name, () => fn()),
        dispatchTool: async (call) => {
          dispatched.push(call.name);
          return {};
        },
      },
    );
    expect(dispatched).toEqual([]);
  });
});

describe('an elicitation settled from the approvals inbox', () => {
  const askDeps: Partial<AgentLoopDeps> = { ask: true };

  it('completes the run on an Approve, taking every pre-picked answer', async () => {
    const journal = new Journal();
    // What `POST /agent/tool-call/:id/approve` sends: the question set is parked as a
    // `pending_approval` action, so the inbox settles it with a Decision and not with answers.
    const { store, frames } = await pass(journal, {
      extra: askDeps,
      script: asks,
      reply: { approved: true, executedByRef: 'admin-7' },
    });
    expect(journal.names()).toContain('persist:toolexec:call-0-ask');
    const [row] = store.toolCallRows();
    expect(row?.status).toBe('executed');
    expect((row?.output as { answers: Record<string, string[]> }).answers).toEqual({
      scope: ['module'],
    });
    expect(frames.some((frame) => (frame as { kind: string }).kind === 'tool-output')).toBe(true);
  });

  it('settles a Reject on the rejection position, exactly as a skip does', async () => {
    const journal = new Journal();
    const { store } = await pass(journal, {
      extra: askDeps,
      script: asks,
      reply: { approved: false },
    });
    expect(journal.names()).toContain('persist:toolreject:call-0-ask');
    expect(store.toolCallRows()[0]?.status).toBe('rejected');
  });

  it('replays the approved run onto the same positions, since the payload is journaled', async () => {
    const journal = new Journal();
    await pass(journal, { extra: askDeps, script: asks, reply: { approved: true } });
    const recorded = journal.names();
    await expect(
      pass(journal, {
        extra: {
          ...askDeps,
          model: {
            runTurn: async () => {
              throw new Error('the replay must not reach the model');
            },
          },
        },
        script: asks,
        reply: { approved: true },
      }),
    ).resolves.toBeDefined();
    expect(journal.names()).toEqual(recorded);
  });

  it('settles a configured intake the same way', async () => {
    const journal = new Journal();
    const { store } = await pass(journal, {
      extra: { intake: INTAKE },
      reply: { approved: true },
    });
    expect(journal.names()).toContain('intake:answers');
    expect(store.toolCallRows()[0]?.status).toBe('executed');
  });
});
