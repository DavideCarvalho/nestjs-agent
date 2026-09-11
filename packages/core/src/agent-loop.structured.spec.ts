import { InMemoryAgentStore } from '@dudousxd/nestjs-agent-testing';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  type AgentLoopDeps,
  type AgentLoopHooks,
  DefaultRolesPolicy,
  type InputProcessor,
  type ModelProvider,
  type ModelTurnArgs,
  type ModelTurnResult,
  type RecordToolCallInput,
  type RecordUsageInput,
  type SinkWriter,
  StructuredOutputError,
  ToolRegistry,
  type UpdateToolCallInput,
  estimateMessageTokens,
  runAgentLoop,
} from './index.js';

const RUN_ID = 'run-1';
const ACTOR = { id: 'u1', roles: ['ADMIN'] };
const REPORT = z.object({ headline: z.string(), rows: z.number() });
type Report = z.infer<typeof REPORT>;

const discard: SinkWriter = { write: () => {}, end: () => {}, fail: () => {} };

/** One turn of prose, or — when `outputSchema` is set — the next scripted formatting reply. */
class ScriptedModel implements ModelProvider {
  readonly seen: ModelTurnArgs[] = [];
  private formatting = 0;

  constructor(
    private readonly prose: Array<{ text: string; toolCall?: string }>,
    private readonly formatted: Array<{ text: string; object?: unknown }> = [],
  ) {}

  async runTurn(args: ModelTurnArgs): Promise<ModelTurnResult> {
    this.seen.push(args);
    if (args.outputSchema !== undefined) {
      const reply = this.formatted[Math.min(this.formatting, this.formatted.length - 1)] ?? {
        text: '{}',
      };
      this.formatting += 1;
      return {
        text: reply.text,
        toolCalls: [],
        usage: { inputTokens: 7, outputTokens: 11 },
        modelId: 'formatter-1',
        ...(reply.object !== undefined ? { object: reply.object } : {}),
      };
    }
    const index = args.messages.filter((message) => message.role === 'assistant').length;
    const turn = this.prose[Math.min(index, this.prose.length - 1)] ?? { text: 'done' };
    await args.sink.write(new TextEncoder().encode(turn.text));
    return {
      text: turn.text,
      toolCalls: turn.toolCall !== undefined ? [{ id: 'c1', name: turn.toolCall, input: {} }] : [],
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
  prose?: Array<{ text: string; toolCall?: string }>;
  formatted?: Array<{ text: string; object?: unknown }>;
  outputSchema?: typeof REPORT;
  outputRepairAttempts?: number;
  outputFromTranscript?: boolean;
  inputProcessors?: InputProcessor[];
  registry?: ToolRegistry;
  step?: AgentLoopHooks['step'];
  /** Exchanges already on the thread before this turn — what the turn's prompt has to carry. */
  priorTurns?: number;
  /** Bytes of tool output on each prior assistant message. */
  priorOutputBytes?: number;
}

interface RunResult {
  text: string;
  object?: Report;
  stepNames: string[];
  usage: RecordUsageInput[];
  model: ScriptedModel;
  toolCallOutputs: unknown[];
}

/** A thread already `turns` exchanges deep, each assistant message carrying a fat tool result. */
async function seedThread(
  store: InMemoryAgentStore,
  threadId: string,
  turns: number,
  outputBytes: number,
): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    await store.appendMessage({ threadId, role: 'user', content: `earlier question ${index}` });
    await store.appendMessage({
      threadId,
      role: 'assistant',
      content: `earlier answer ${index}`,
      toolCalls: [{ id: `old-${index}`, name: 'lookup', input: {}, kind: 'read' }],
      toolResults: [
        { id: `old-${index}`, name: 'lookup', output: { rows: 'r'.repeat(outputBytes) } },
      ],
    });
  }
}

async function run(options: RunOptions = {}): Promise<RunResult> {
  const store = new InMemoryAgentStore();
  const thread = await store.createThread({ actor: ACTOR });
  await seedThread(store, thread.id, options.priorTurns ?? 0, options.priorOutputBytes ?? 8192);
  const usage: RecordUsageInput[] = [];
  const recorded: Array<{ toolName: string; output: unknown }> = [];
  const model = new ScriptedModel(
    options.prose ?? [{ text: '42 rows, all clean.' }],
    options.formatted ?? [{ text: '{"headline":"all clean","rows":42}' }],
  );
  const deps: AgentLoopDeps<Report> = {
    model,
    store: Object.assign(Object.create(store) as InMemoryAgentStore, {
      recordUsage: async (row: RecordUsageInput) => {
        usage.push(row);
        await store.recordUsage(row);
      },
      recordToolCall: async (call: RecordToolCallInput) => {
        recorded.push({ toolName: call.toolName, output: undefined });
        await store.recordToolCall(call);
      },
      updateToolCall: async (call: UpdateToolCallInput) => {
        const last = recorded.at(-1);
        if (last !== undefined) {
          last.output = call.output;
        }
        await store.updateToolCall(call);
      },
    }),
    registry: options.registry ?? new ToolRegistry(),
    rolesPolicy: new DefaultRolesPolicy(),
    modelId: 'fake-1',
    day: '2026-06-30',
    systemPrompt: 'You are a test agent.',
    ...(options.outputSchema !== undefined ? { outputSchema: options.outputSchema } : {}),
    ...(options.outputRepairAttempts !== undefined
      ? { outputRepairAttempts: options.outputRepairAttempts }
      : {}),
    ...(options.outputFromTranscript !== undefined
      ? { outputFromTranscript: options.outputFromTranscript }
      : {}),
    ...(options.inputProcessors !== undefined ? { inputProcessors: options.inputProcessors } : {}),
  };
  const stepNames: string[] = [];
  const hooks: AgentLoopHooks = {
    runId: RUN_ID,
    openSink: () => discard,
    awaitApproval: async () => ({ approved: true }),
    step: (name, fn) => {
      stepNames.push(name);
      return options.step !== undefined ? options.step(name, fn) : fn();
    },
  };
  const result = await runAgentLoop(
    deps,
    { threadId: thread.id, actor: ACTOR, userText: 'how many rows?' },
    hooks,
  );
  return {
    text: result.text,
    ...(result.object !== undefined ? { object: result.object } : {}),
    stepNames,
    usage,
    model,
    toolCallOutputs: recorded
      .filter((call) => call.toolName === 'structured_output')
      .map((call) => call.output),
  };
}

describe('agent loop — structured output', () => {
  it('answers in free text and takes the same checkpoints when no schema is declared', async () => {
    const { text, object, stepNames } = await run();
    expect(text).toBe('42 rows, all clean.');
    expect(object).toBeUndefined();
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

  it('returns the answer validated against the schema, keeping the prose as the message', async () => {
    const { text, object, stepNames } = await run({ outputSchema: REPORT });
    expect(object).toEqual({ headline: 'all clean', rows: 42 });
    // The prose is what the user read; the schema is a restatement for the calling code.
    expect(text).toBe('42 rows, all clean.');
    expect(stepNames).toContain('structured:0:0');
    expect(stepNames).toContain('persist:usage:structured:0:0');
  });

  it('asks for the schema on a call carrying NO tools, which is what lets both features coexist', async () => {
    const { model } = await run({
      prose: [{ text: 'looking', toolCall: 'peek' }, { text: '42 rows' }],
      registry: registryWithPeek(),
      outputSchema: REPORT,
    });
    const constrained = model.seen.filter((args) => args.outputSchema !== undefined);
    // The turn called its tool normally; exactly one formatting pass follows the final answer, and
    // it offers the model no tools — most providers refuse a response format and a tool set together.
    expect(constrained).toHaveLength(1);
    expect(constrained[0]?.tools).toEqual([]);
    // …and every call that DID carry the tool set was a normal turn, never the constrained one.
    expect(
      model.seen.map((args) => ({
        tools: args.tools.length,
        constrained: args.outputSchema !== undefined,
      })),
    ).toEqual([
      { tools: 1, constrained: false },
      { tools: 1, constrained: false },
      { tools: 0, constrained: true },
    ]);
  });

  it('shows the formatting pass the answer it has to restate', async () => {
    const { model } = await run({ outputSchema: REPORT });
    const constrained = model.seen.find((args) => args.outputSchema !== undefined);
    expect(constrained?.messages.at(-1)).toEqual({
      role: 'assistant',
      content: '42 rows, all clean.',
    });
  });

  it('shows it the question and the answer, and nothing else off the thread', async () => {
    const { model } = await run({ priorTurns: 20, outputSchema: REPORT });
    const constrained = model.seen.find((args) => args.outputSchema !== undefined);
    // A translation of one answer needs the answer and what was asked for. The 40 messages behind
    // them are what the answer was derived FROM, and the pass is told not to derive anything.
    expect(constrained?.messages).toEqual([
      { role: 'user', content: 'how many rows?' },
      { role: 'assistant', content: '42 rows, all clean.' },
    ]);
  });

  it('costs the same whatever the thread behind it has grown to', async () => {
    const shallow = await run({ priorTurns: 0, outputSchema: REPORT });
    const deep = await run({ priorTurns: 30, outputSchema: REPORT });
    const cost = (args: ModelTurnArgs | undefined): number =>
      (args?.messages ?? []).reduce((total, message) => total + estimateMessageTokens(message), 0);
    const passOf = (result: RunResult) =>
      result.model.seen.find((args) => args.outputSchema !== undefined);
    const turnOf = (result: RunResult) =>
      result.model.seen.find((args) => args.outputSchema === undefined);

    // The measurement, not the shape: the pass is a fixed cost, so a regression that puts the
    // transcript back shows up here rather than on a bill.
    expect(cost(passOf(deep))).toBe(cost(passOf(shallow)));
    expect(cost(passOf(deep))).toBeLessThan(cost(turnOf(deep)) / 20);
  });

  it('restates the question the input chain let through, not the one the user typed', async () => {
    const redact: InputProcessor = {
      name: 'redact',
      process: (prompt) => ({
        ...prompt,
        messages: prompt.messages.map((message) =>
          message.role === 'user' ? { ...message, content: '[redacted]' } : message,
        ),
      }),
    };
    const { model } = await run({ outputSchema: REPORT, inputProcessors: [redact] });
    const constrained = model.seen.find((args) => args.outputSchema !== undefined);
    // The pass is a second route out of the model, so it reads the prompt the chain built — a
    // question the chain masked must not reappear here in the clear.
    expect(constrained?.messages[0]).toEqual({ role: 'user', content: '[redacted]' });
  });

  it('hands the whole transcript to an agent that asked for it', async () => {
    const { model } = await run({
      priorTurns: 2,
      outputSchema: REPORT,
      outputFromTranscript: true,
    });
    const constrained = model.seen.find((args) => args.outputSchema !== undefined);
    expect(constrained?.messages.map((message) => message.content)).toEqual([
      'earlier question 0',
      'earlier answer 0',
      'earlier question 1',
      'earlier answer 1',
      'how many rows?',
      '42 rows, all clean.',
    ]);
  });

  it('bills the extra call as its own `structured_output` usage row', async () => {
    const { usage } = await run({ outputSchema: REPORT });
    expect(usage.map((row) => row.purpose)).toEqual(['chat', 'structured_output']);
    expect(usage[1]).toMatchObject({
      modelId: 'formatter-1',
      usage: { inputTokens: 7, outputTokens: 11 },
    });
  });

  it('records the structured value on the assistant message, so a thread reader gets it too', async () => {
    const { toolCallOutputs } = await run({ outputSchema: REPORT });
    expect(toolCallOutputs).toEqual([{ headline: 'all clean', rows: 42 }]);
  });

  it('repairs one invalid reply, showing the model what failed', async () => {
    const { object, model, stepNames } = await run({
      outputSchema: REPORT,
      formatted: [
        { text: '{"headline":"all clean"}' },
        { text: '{"headline":"all clean","rows":42}' },
      ],
    });
    expect(object).toEqual({ headline: 'all clean', rows: 42 });
    const constrained = model.seen.filter((args) => args.outputSchema !== undefined);
    expect(constrained).toHaveLength(2);
    expect(constrained[1]?.system).toContain('Your previous reply was rejected');
    expect(constrained[1]?.system).toContain('rows');
    expect(stepNames).toContain('structured:0:1');
  });

  it('gives up after the bounded attempts, carrying the issues and the text that failed them', async () => {
    const failure = await run({
      outputSchema: REPORT,
      formatted: [{ text: 'I am afraid I cannot do that.' }],
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(StructuredOutputError);
    expect(failure).toMatchObject({ text: 'I am afraid I cannot do that.', attempts: 2 });
  });

  it('stops asking after the bound, rather than paying for a model that cannot comply', async () => {
    const model = new ScriptedModel([{ text: '42 rows' }], [{ text: 'never valid' }]);
    const store = new InMemoryAgentStore();
    const thread = await store.createThread({ actor: ACTOR });
    await runAgentLoop(
      {
        model,
        store,
        registry: new ToolRegistry(),
        rolesPolicy: new DefaultRolesPolicy(),
        modelId: 'fake-1',
        day: '2026-06-30',
        systemPrompt: 'base',
        outputSchema: REPORT,
        outputRepairAttempts: 2,
      },
      { threadId: thread.id, actor: ACTOR, userText: 'how many rows?' },
      {
        runId: RUN_ID,
        openSink: () => discard,
        awaitApproval: async () => ({ approved: true }),
        step: (_name, fn) => fn(),
      },
    ).catch(() => undefined);
    expect(model.seen.filter((args) => args.outputSchema !== undefined)).toHaveLength(3);
  });

  it('spends exactly one call when repair is turned off', async () => {
    const failure = await run({
      outputSchema: REPORT,
      outputRepairAttempts: 0,
      formatted: [{ text: 'nope' }],
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ attempts: 1 });
  });

  it('validates a provider’s own parsed object rather than taking its word for it', async () => {
    const failure = await run({
      outputSchema: REPORT,
      outputRepairAttempts: 0,
      // A provider that reports a parsed value it never actually constrained.
      formatted: [{ text: '{"headline":"all clean","rows":42}', object: { headline: 7 } }],
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(StructuredOutputError);
  });

  it('reads the formatting pass back from its checkpoint instead of re-asking the model', async () => {
    const recorded = new Map<string, string>();
    const step: AgentLoopHooks['step'] = async (name, fn) => {
      if (!name.startsWith('structured:')) {
        return fn();
      }
      const cached = recorded.get(name);
      if (cached !== undefined) {
        return JSON.parse(cached) as never;
      }
      const value = await fn();
      recorded.set(name, JSON.stringify(value));
      return value;
    };
    const first = await run({ outputSchema: REPORT, step });
    const second = await run({ outputSchema: REPORT, step });
    expect(first.object).toEqual({ headline: 'all clean', rows: 42 });
    expect(second.object).toEqual({ headline: 'all clean', rows: 42 });
    // One genuine formatting call across both passes — the replay resolved it from the journal.
    expect(second.model.seen.filter((args) => args.outputSchema !== undefined)).toHaveLength(0);
  });
});
