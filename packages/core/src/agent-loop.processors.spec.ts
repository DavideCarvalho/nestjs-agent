import { InMemoryAgentStore } from '@dudousxd/nestjs-agent-testing';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  type AgentLoopDeps,
  type AgentLoopHooks,
  type AgentStreamEvent,
  DefaultRolesPolicy,
  type InputProcessor,
  type ModelMessage,
  type ModelProvider,
  type ModelTurnArgs,
  type ModelTurnResult,
  type OutputProcessor,
  OutputRejectedError,
  ProcessorFailedError,
  type RecordUsageInput,
  type SinkWriter,
  ToolRegistry,
  type ToolResult,
  decodeStreamEvent,
  encodeStreamEvent,
  runAgentLoop,
} from './index.js';

const RUN_ID = 'run-1';
const ACTOR = { id: 'u1', roles: ['ADMIN'] };

/** Collects the sink as decoded frames, so a test can assert WHEN each one arrived, not just that it did. */
function recordingSink(): { writer: SinkWriter; frames: () => AgentStreamEvent[] } {
  const decoder = new TextDecoder();
  const lines: string[] = [];
  return {
    writer: {
      write: (chunk) => {
        for (const line of decoder.decode(chunk).split('\n')) {
          if (line.length > 0) {
            lines.push(line);
          }
        }
      },
      end: () => {},
      fail: () => {},
    },
    frames: () =>
      lines.map(decodeStreamEvent).filter((event): event is AgentStreamEvent => event !== null),
  };
}

/** What each turn of the scripted model does. */
interface Scripted {
  text: string;
  toolCall?: { id: string; name: string };
}

/** Writes the `AgentStreamEvent` vocabulary a real adapter writes: text deltas, then the tool card. */
class ScriptedModel implements ModelProvider {
  readonly seen: ModelTurnArgs[] = [];

  constructor(private readonly turns: Scripted[]) {}

  async runTurn(args: ModelTurnArgs): Promise<ModelTurnResult> {
    this.seen.push(args);
    const index = args.messages.filter((message) => message.role === 'assistant').length;
    const turn = this.turns[Math.min(index, this.turns.length - 1)] ?? { text: 'done' };
    for (const word of turn.text.split(' ')) {
      await args.sink.write(encodeStreamEvent({ kind: 'text', text: word }));
    }
    if (turn.toolCall !== undefined) {
      await args.sink.write(
        encodeStreamEvent({
          kind: 'tool-input-available',
          id: turn.toolCall.id,
          name: turn.toolCall.name,
          input: {},
          toolKind: 'read',
        }),
      );
    }
    return {
      text: turn.text,
      toolCalls:
        turn.toolCall !== undefined
          ? [{ id: turn.toolCall.id, name: turn.toolCall.name, input: {} }]
          : [],
      usage: { inputTokens: args.messages.length, outputTokens: turn.text.length },
    };
  }
}

function registryWithPeek(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(
    { name: 'peek', kind: 'read', description: 'peek', inputSchema: z.object({}) },
    { execute: async () => ({ seen: true }) },
  );
  return registry;
}

interface RunOptions {
  turns?: Scripted[];
  inputProcessors?: InputProcessor[];
  outputProcessors?: OutputProcessor[];
  registry?: ToolRegistry;
  step?: AgentLoopHooks['step'];
}

interface RunResult {
  text: string;
  stepNames: string[];
  frames: AgentStreamEvent[];
  usage: RecordUsageInput[];
  model: ScriptedModel;
  messages: ModelMessage[];
  toolResults: ToolResult[] | undefined;
}

async function run(options: RunOptions = {}): Promise<RunResult> {
  const store = new InMemoryAgentStore();
  const thread = await store.createThread({ actor: ACTOR });
  const usage: RecordUsageInput[] = [];
  const model = new ScriptedModel(options.turns ?? [{ text: 'the quiet answer' }]);
  const sink = recordingSink();
  const deps: AgentLoopDeps = {
    model,
    store: {
      ...store,
      getThread: (id) => store.getThread(id),
      appendMessage: (message) => store.appendMessage(message),
      setMessageToolResults: (messageId, results) =>
        store.setMessageToolResults(messageId, results),
      recordUsage: async (row) => {
        usage.push(row);
        await store.recordUsage(row);
      },
      recordToolCall: (call) => store.recordToolCall(call),
      updateToolCall: (call) => store.updateToolCall(call),
      setTitle: (id, title) => store.setTitle(id, title),
      truncateFrom: (id, messageId) => store.truncateFrom(id, messageId),
    },
    registry: options.registry ?? new ToolRegistry(),
    rolesPolicy: new DefaultRolesPolicy(),
    modelId: 'fake-1',
    day: '2026-06-30',
    systemPrompt: 'You are a test agent.',
    ...(options.inputProcessors !== undefined ? { inputProcessors: options.inputProcessors } : {}),
    ...(options.outputProcessors !== undefined
      ? { outputProcessors: options.outputProcessors }
      : {}),
  };
  const stepNames: string[] = [];
  const hooks: AgentLoopHooks = {
    runId: RUN_ID,
    openSink: () => sink.writer,
    awaitApproval: async () => ({ approved: true }),
    step: (name, fn) => {
      stepNames.push(name);
      return options.step !== undefined ? options.step(name, fn) : fn();
    },
  };
  const result = await runAgentLoop(
    deps,
    { threadId: thread.id, actor: ACTOR, userText: 'hi' },
    hooks,
  );
  const stored = await store.getThread(thread.id);
  return {
    text: result.text,
    stepNames,
    frames: sink.frames(),
    usage,
    model,
    messages: stored?.messages ?? [],
    toolResults: stored?.messages.find((message) => message.role === 'assistant')?.toolResults,
  };
}

/** Text as it reached the subscriber — one entry per `text` frame, so chunking is visible. */
function streamedText(frames: AgentStreamEvent[]): string[] {
  return frames.filter((frame) => frame.kind === 'text').map((frame) => frame.text);
}

describe('agent loop — input processors', () => {
  it('sends the untouched prompt and takes the same checkpoints when none are registered', async () => {
    const { stepNames, model } = await run();
    expect(model.seen[0]?.system).toBe('You are a test agent.');
    expect(stepNames).toEqual([
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

  it('rewrites what the model is sent without rewriting the thread', async () => {
    const redact: InputProcessor = {
      name: 'redact',
      process: (prompt) => ({
        system: `${prompt.system} Never echo an SSN.`,
        messages: prompt.messages.map((message) => ({
          ...message,
          content: message.content.replace(/\d{3}-\d{2}-\d{4}/, '[ssn]'),
        })),
      }),
    };
    const store = new InMemoryAgentStore();
    const thread = await store.createThread({ actor: ACTOR });
    const model = new ScriptedModel([{ text: 'ok' }]);
    const sink = recordingSink();
    await runAgentLoop(
      {
        model,
        store,
        registry: new ToolRegistry(),
        rolesPolicy: new DefaultRolesPolicy(),
        modelId: 'fake-1',
        day: '2026-06-30',
        systemPrompt: 'base',
        inputProcessors: [redact],
      },
      { threadId: thread.id, actor: ACTOR, userText: 'my ssn is 123-45-6789' },
      {
        runId: RUN_ID,
        openSink: () => sink.writer,
        awaitApproval: async () => ({ approved: true }),
        step: (_name, fn) => fn(),
      },
    );
    expect(model.seen[0]?.system).toBe('base Never echo an SSN.');
    expect(model.seen[0]?.messages.at(-1)?.content).toBe('my ssn is [ssn]');
    // The transformation is what LEAVES the process, not the thread's own memory of what was said.
    const stored = await store.getThread(thread.id);
    expect(stored?.messages[0]?.content).toBe('my ssn is 123-45-6789');
  });

  it('runs before every model call of the turn, not just the first', async () => {
    const steps: number[] = [];
    const tag: InputProcessor = {
      name: 'tag',
      process: (prompt, ctx) => {
        steps.push(ctx.step);
        return { ...prompt, system: `${prompt.system} [step ${ctx.step}]` };
      },
    };
    const { model, stepNames } = await run({
      turns: [{ text: 'looking', toolCall: { id: 'c1', name: 'peek' } }, { text: 'done' }],
      registry: registryWithPeek(),
      inputProcessors: [tag],
    });
    expect(steps).toEqual([0, 1]);
    expect(model.seen[1]?.system).toContain('[step 1]');
    expect(stepNames.filter((name) => name.startsWith('process:input'))).toEqual([
      'process:input:0',
      'process:input:1',
    ]);
  });

  it('journals the rewritten prompt, so a replay does not compose a different one', async () => {
    let calls = 0;
    const stamp: InputProcessor = {
      name: 'stamp',
      process: (prompt) => {
        calls += 1;
        return { ...prompt, system: `${prompt.system} #${calls}` };
      },
    };
    // The replay contract for this one checkpoint: the first pass runs the body and records what it
    // returned, a later pass returns the record without running it — round-tripped through JSON, as
    // a real journal's entries are.
    let recorded: string | undefined;
    const step: AgentLoopHooks['step'] = async (name, fn) => {
      if (name !== 'process:input:0') {
        return fn();
      }
      if (recorded !== undefined) {
        return JSON.parse(recorded) as never;
      }
      const value = await fn();
      recorded = JSON.stringify(value);
      return value;
    };
    const first = await run({ inputProcessors: [stamp], step });
    const second = await run({ inputProcessors: [stamp], step });
    expect(calls).toBe(1);
    expect(first.model.seen[0]?.system).toContain('#1');
    expect(second.model.seen[0]?.system).toContain('#1');
  });

  it('names the processor that threw, so it cannot read as the model failing', async () => {
    const broken: InputProcessor = {
      name: 'pii-scan',
      process: () => {
        throw new Error('classifier unreachable');
      },
    };
    await expect(run({ inputProcessors: [broken] })).rejects.toThrow(ProcessorFailedError);
    await expect(run({ inputProcessors: [broken] })).rejects.toThrow(
      'input processor "pii-scan" failed: classifier unreachable',
    );
  });
});

describe('agent loop — output processors', () => {
  it('streams the model’s frames live and takes no extra checkpoint when none are registered', async () => {
    const { frames, stepNames } = await run();
    // Chunk-by-chunk, exactly as the model wrote them.
    expect(streamedText(frames)).toEqual(['the', 'quiet', 'answer']);
    expect(stepNames).not.toContain('process:output:0');
  });

  it('holds every frame until the gate has passed', async () => {
    let framesWhenGateRan = -1;
    const sink = recordingSink();
    const model = new ScriptedModel([{ text: 'the quiet answer' }]);
    const store = new InMemoryAgentStore();
    const thread = await store.createThread({ actor: ACTOR });
    const watcher: OutputProcessor = {
      name: 'watcher',
      process: () => {
        framesWhenGateRan = sink.frames().length;
        return { action: 'pass' };
      },
    };
    await runAgentLoop(
      {
        model,
        store,
        registry: new ToolRegistry(),
        rolesPolicy: new DefaultRolesPolicy(),
        modelId: 'fake-1',
        day: '2026-06-30',
        systemPrompt: 'base',
        outputProcessors: [watcher],
      },
      { threadId: thread.id, actor: ACTOR, userText: 'hi' },
      {
        runId: RUN_ID,
        openSink: () => sink.writer,
        awaitApproval: async () => ({ approved: true }),
        step: (_name, fn) => fn(),
      },
    );
    // Nothing the model produced had reached the subscriber while the gate was deciding — the whole
    // point of the buffer. (`step-start` is the loop's own frame, written before the model ran.)
    expect(framesWhenGateRan).toBe(1);
    expect(streamedText(sink.frames())).toEqual(['the quiet answer']);
  });

  it('streams, persists and returns the REPLACED text, never the model’s own', async () => {
    const redact: OutputProcessor = {
      name: 'redact',
      process: (answer) => ({
        action: 'replace',
        text: answer.text.replace('quiet', '[redacted]'),
      }),
    };
    const { text, frames, messages } = await run({ outputProcessors: [redact] });
    expect(text).toBe('the [redacted] answer');
    expect(streamedText(frames)).toEqual(['the [redacted] answer']);
    expect(messages.find((message) => message.role === 'assistant')?.content).toBe(
      'the [redacted] answer',
    );
    expect(JSON.stringify(frames)).not.toContain('quiet');
  });

  it('keeps the turn’s tool-call frames, which the gate does not own', async () => {
    const pass: OutputProcessor = { name: 'pass', process: () => ({ action: 'pass' }) };
    const { frames } = await run({
      turns: [{ text: 'looking', toolCall: { id: 'c1', name: 'peek' } }, { text: 'done' }],
      registry: registryWithPeek(),
      outputProcessors: [pass],
    });
    expect(frames.filter((frame) => frame.kind === 'tool-input-available')).toHaveLength(1);
    expect(streamedText(frames)).toEqual(['looking', 'done']);
  });

  it('feeds each processor what the previous one produced', async () => {
    const seen: string[] = [];
    const upper: OutputProcessor = {
      name: 'upper',
      process: (answer) => ({ action: 'replace', text: answer.text.toUpperCase() }),
    };
    const observer: OutputProcessor = {
      name: 'observer',
      process: (answer) => {
        seen.push(answer.text);
        return { action: 'pass' };
      },
    };
    const { text } = await run({ outputProcessors: [upper, observer] });
    expect(seen).toEqual(['THE QUIET ANSWER']);
    expect(text).toBe('THE QUIET ANSWER');
  });

  it('refuses the turn: nothing streamed, nothing persisted, the caller told who refused', async () => {
    const refuse: OutputProcessor = {
      name: 'sql-guard',
      process: () => ({ action: 'reject', reason: 'answer contains raw customer rows' }),
    };
    const store = new InMemoryAgentStore();
    const thread = await store.createThread({ actor: ACTOR });
    const sink = recordingSink();
    const failure = await runAgentLoop(
      {
        model: new ScriptedModel([{ text: 'the quiet answer' }]),
        store,
        registry: new ToolRegistry(),
        rolesPolicy: new DefaultRolesPolicy(),
        modelId: 'fake-1',
        day: '2026-06-30',
        systemPrompt: 'base',
        outputProcessors: [refuse],
      },
      { threadId: thread.id, actor: ACTOR, userText: 'hi' },
      {
        runId: RUN_ID,
        openSink: () => sink.writer,
        awaitApproval: async () => ({ approved: true }),
        step: (_name, fn) => fn(),
      },
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(OutputRejectedError);
    expect(failure).toMatchObject({
      processor: 'sql-guard',
      reason: 'answer contains raw customer rows',
    });
    expect(streamedText(sink.frames())).toEqual([]);
    const stored = await store.getThread(thread.id);
    expect(stored?.messages.map((message) => message.role)).toEqual(['user']);
  });

  it('still records what the refused turn spent', async () => {
    const refuse: OutputProcessor = {
      name: 'guard',
      process: () => ({ action: 'reject', reason: 'no' }),
    };
    const usage: RecordUsageInput[] = [];
    const store = new InMemoryAgentStore();
    const thread = await store.createThread({ actor: ACTOR });
    const sink = recordingSink();
    await runAgentLoop(
      {
        model: new ScriptedModel([{ text: 'the quiet answer' }]),
        store: Object.assign(Object.create(store) as InMemoryAgentStore, {
          recordUsage: async (row: RecordUsageInput) => void usage.push(row),
        }),
        registry: new ToolRegistry(),
        rolesPolicy: new DefaultRolesPolicy(),
        modelId: 'fake-1',
        day: '2026-06-30',
        systemPrompt: 'base',
        outputProcessors: [refuse],
      },
      { threadId: thread.id, actor: ACTOR, userText: 'hi' },
      {
        runId: RUN_ID,
        openSink: () => sink.writer,
        awaitApproval: async () => ({ approved: true }),
        step: (_name, fn) => fn(),
      },
    ).catch(() => undefined);
    // Those tokens were genuinely spent; a gate that hid its own cost would burn a budget invisibly.
    expect(usage.map((row) => row.purpose)).toEqual(['chat']);
  });

  it('stops at the first refusal instead of billing the rest of the chain', async () => {
    let laterRan = false;
    const refuse: OutputProcessor = {
      name: 'first',
      process: () => ({ action: 'reject', reason: 'no' }),
    };
    const later: OutputProcessor = {
      name: 'second',
      process: () => {
        laterRan = true;
        return { action: 'pass' };
      },
    };
    await run({ outputProcessors: [refuse, later] }).catch(() => undefined);
    expect(laterRan).toBe(false);
  });

  it('names the processor that threw, so it cannot read as the model failing', async () => {
    const broken: OutputProcessor = {
      name: 'moderation',
      process: () => Promise.reject(new Error('judge timed out')),
    };
    await expect(run({ outputProcessors: [broken] })).rejects.toThrow(ProcessorFailedError);
    await expect(run({ outputProcessors: [broken] })).rejects.toThrow(
      'output processor "moderation" failed: judge timed out',
    );
  });

  it('releases the held answer after a suspend between the model call and the gate', async () => {
    // The frames ride the `llm:<i>` CHECKPOINT, not a variable in the process that ran the model.
    // A run that unwinds before the gate resumes in a process that never saw the model's stream, so
    // a buffer held in memory would leave the turn's whole answer unstreamed.
    const journal = new Map<string, string | null>();
    let suspended = false;
    const step: AgentLoopHooks['step'] = async (name, fn) => {
      const cached = journal.get(name);
      if (cached !== undefined) {
        return (cached === null ? undefined : JSON.parse(cached)) as never;
      }
      if (name === 'process:output:0' && !suspended) {
        suspended = true;
        throw new Error('suspended before the gate');
      }
      const value = await fn();
      journal.set(name, value === undefined ? null : JSON.stringify(value));
      return value;
    };
    const store = new InMemoryAgentStore();
    const thread = await store.createThread({ actor: ACTOR });
    const sink = recordingSink();
    const pass: OutputProcessor = { name: 'pass', process: () => ({ action: 'pass' }) };
    const attempt = () =>
      runAgentLoop(
        {
          model: new ScriptedModel([
            { text: 'the quiet answer', toolCall: { id: 'c1', name: 'peek' } },
            { text: 'done' },
          ]),
          store,
          registry: registryWithPeek(),
          rolesPolicy: new DefaultRolesPolicy(),
          modelId: 'fake-1',
          day: '2026-06-30',
          systemPrompt: 'base',
          outputProcessors: [pass],
        },
        { threadId: thread.id, actor: ACTOR, userText: 'hi' },
        {
          runId: RUN_ID,
          openSink: () => sink.writer,
          awaitApproval: async () => ({ approved: true }),
          step,
        },
      );
    await expect(attempt()).rejects.toThrow('suspended before the gate');
    expect(streamedText(sink.frames())).toEqual([]);
    await attempt();
    expect(streamedText(sink.frames())).toEqual(['the quiet answer', 'done']);
    // The tool card the model streamed alongside that answer survived the suspend too — it exists
    // nowhere but the `llm:0` checkpoint by the time the gate runs.
    expect(sink.frames().filter((frame) => frame.kind === 'tool-input-available')).toHaveLength(1);
  });

  it('does not re-release a gated turn when its checkpoint is replayed', async () => {
    const pass: OutputProcessor = { name: 'pass', process: () => ({ action: 'pass' }) };
    let recorded: string | undefined;
    // `process:output:<i>` performs the release, so replaying it MUST NOT run the body again — a
    // second flush would stream the same answer twice into a stream a subscriber is still reading.
    const step: AgentLoopHooks['step'] = async (name, fn) => {
      if (name !== 'process:output:0') {
        return fn();
      }
      if (recorded !== undefined) {
        return JSON.parse(recorded) as never;
      }
      const value = await fn();
      recorded = JSON.stringify(value);
      return value;
    };
    await run({ outputProcessors: [pass], step });
    const second = await run({ outputProcessors: [pass], step });
    expect(streamedText(second.frames)).toEqual([]);
  });
});
