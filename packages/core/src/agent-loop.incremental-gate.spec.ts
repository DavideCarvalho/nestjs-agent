import { InMemoryAgentStore } from '@dudousxd/nestjs-agent-testing';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  type AgentLoopDeps,
  type AgentLoopHooks,
  type AgentStreamEvent,
  type BufferedModelTurnResult,
  DEFAULT_INCREMENTAL_LOOKBACK_CHARS,
  DefaultRolesPolicy,
  type LlmStepEnvelope,
  type ModelProvider,
  type ModelTurnArgs,
  type ModelTurnResult,
  type OutputProcessor,
  OutputRejectedError,
  ProcessorFailedError,
  type QuotaStore,
  type RecordUsageInput,
  type SinkWriter,
  ToolRegistry,
  createFrameBuffer,
  decodeStreamEvent,
  encodeStreamEvent,
  runAgentLoop,
} from './index.js';

const RUN_ID = 'run-1';
const ACTOR = { id: 'u1', roles: ['ADMIN'] };

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

/** Text as it reached the subscriber — one entry per `text` frame, so chunking is visible. */
function streamedText(frames: AgentStreamEvent[]): string[] {
  return frames.filter((frame) => frame.kind === 'text').map((frame) => frame.text);
}

interface Scripted {
  text: string;
  /** Characters per streamed `text` frame. */
  chunk?: number;
  toolCall?: { id: string; name: string };
}

/** Streams a scripted answer in fixed-size `text` frames, so a test controls where the cuts fall. */
class ChunkedModel implements ModelProvider {
  constructor(private readonly turns: Scripted[]) {}

  async runTurn(args: ModelTurnArgs): Promise<ModelTurnResult> {
    const index = args.messages.filter((message) => message.role === 'assistant').length;
    const turn = this.turns[Math.min(index, this.turns.length - 1)] ?? { text: 'done' };
    const size = turn.chunk ?? 2;
    for (let at = 0; at < turn.text.length; at += size) {
      await args.sink.write(
        encodeStreamEvent({ kind: 'text', text: turn.text.slice(at, at + size) }),
      );
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
  outputProcessors?: OutputProcessor[];
  registry?: ToolRegistry;
  quota?: QuotaStore;
  step?: AgentLoopHooks['step'];
  dispatchLlm?: AgentLoopHooks['dispatchLlm'];
  sink?: ReturnType<typeof recordingSink>;
  store?: InMemoryAgentStore;
}

interface RunResult {
  text: string;
  stepNames: string[];
  frames: AgentStreamEvent[];
  usage: RecordUsageInput[];
  storedText: string | undefined;
  error: unknown;
}

async function run(options: RunOptions = {}): Promise<RunResult> {
  const store = options.store ?? new InMemoryAgentStore();
  const thread = await store.createThread({ actor: ACTOR });
  const usage: RecordUsageInput[] = [];
  const sink = options.sink ?? recordingSink();
  const deps: AgentLoopDeps = {
    model: new ChunkedModel(options.turns ?? [{ text: 'abcdefghij' }]),
    store: Object.assign(Object.create(store) as InMemoryAgentStore, {
      recordUsage: async (row: RecordUsageInput) => {
        usage.push(row);
        await store.recordUsage(row);
      },
    }),
    registry: options.registry ?? new ToolRegistry(),
    rolesPolicy: new DefaultRolesPolicy(),
    modelId: 'fake-1',
    day: '2026-06-30',
    systemPrompt: 'base',
    ...(options.outputProcessors !== undefined
      ? { outputProcessors: options.outputProcessors }
      : {}),
    ...(options.quota !== undefined ? { quota: options.quota } : {}),
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
    ...(options.dispatchLlm !== undefined ? { dispatchLlm: options.dispatchLlm } : {}),
  };
  let text = '';
  let error: unknown;
  try {
    const result = await runAgentLoop(
      deps,
      { threadId: thread.id, actor: ACTOR, userText: 'hi' },
      hooks,
    );
    text = result.text;
  } catch (caught) {
    error = caught;
  }
  const stored = await store.getThread(thread.id);
  return {
    text,
    stepNames,
    frames: sink.frames(),
    usage,
    storedText: stored?.messages.find((message) => message.role === 'assistant')?.content,
    error,
  };
}

/** Hands the text on unchanged; only its declaration is under test. */
function passthrough(incremental?: { lookbackChars?: number }): OutputProcessor {
  return {
    name: 'passthrough',
    ...(incremental !== undefined ? { incremental } : {}),
    process: () => ({ action: 'pass' }),
  };
}

function redactor(pattern: RegExp, incremental?: { lookbackChars?: number }): OutputProcessor {
  return {
    name: 'redact',
    ...(incremental !== undefined ? { incremental } : {}),
    process: (answer) => ({ action: 'replace', text: answer.text.replace(pattern, '[redacted]') }),
  };
}

describe('agent loop — incremental output gating', () => {
  it('releases the answer as it arrives instead of one frame at the end', async () => {
    const { frames, text, storedText } = await run({
      outputProcessors: [passthrough({ lookbackChars: 2 })],
    });
    // Each release is the transformed prefix minus the declared window; the final pass emits the
    // tail it was still holding.
    expect(streamedText(frames)).toEqual(['ab', 'cd', 'ef', 'gh', 'ij']);
    expect(text).toBe('abcdefghij');
    expect(storedText).toBe('abcdefghij');
  });

  it('takes the same checkpoints as a whole-answer gate, so a declaration never moves a position', async () => {
    const whole = await run({ outputProcessors: [passthrough()] });
    const incremental = await run({ outputProcessors: [passthrough({ lookbackChars: 2 })] });
    expect(incremental.stepNames).toEqual(whole.stepNames);
    expect(whole.stepNames).toContain('process:output:0');
    // And the ungated turn keeps the sequence it always had — one checkpoint fewer, same names.
    const off = await run();
    expect(off.stepNames).toEqual(whole.stepNames.filter((name) => name !== 'process:output:0'));
    expect(streamedText(whole.frames)).toEqual(['abcdefghij']);
    expect(streamedText(off.frames)).toEqual(['ab', 'cd', 'ef', 'gh', 'ij']);
  });

  it('takes DEFAULT_INCREMENTAL_LOOKBACK_CHARS from a processor that declares no window', async () => {
    const text = 'a'.repeat(DEFAULT_INCREMENTAL_LOOKBACK_CHARS * 2);
    const implicit = await run({ turns: [{ text }], outputProcessors: [passthrough({})] });
    const explicit = await run({
      turns: [{ text }],
      outputProcessors: [passthrough({ lookbackChars: DEFAULT_INCREMENTAL_LOOKBACK_CHARS })],
    });
    expect(streamedText(implicit.frames)).toEqual(streamedText(explicit.frames));
    expect(streamedText(implicit.frames).length).toBeGreaterThan(1);
    expect(streamedText(implicit.frames).join('')).toBe(text);
    // And the window really is what holds text back: widen it past the answer and there is no
    // releasable prefix at all. A window is the answer's minimum latency tail, not a free knob.
    const wider = await run({
      turns: [{ text }],
      outputProcessors: [passthrough({ lookbackChars: DEFAULT_INCREMENTAL_LOOKBACK_CHARS * 2 })],
    });
    expect(streamedText(wider.frames)).toEqual([text]);
  });

  it('falls back to whole-answer buffering when any processor in the chain is undeclared', async () => {
    // An author who wrote against the complete text is never silently downgraded by a neighbour.
    const { frames } = await run({
      outputProcessors: [passthrough({ lookbackChars: 2 }), passthrough()],
    });
    expect(streamedText(frames)).toEqual(['abcdefghij']);
  });

  it('holds the declared window, so a pattern split across chunks is still redacted', async () => {
    const { frames, text } = await run({
      turns: [{ text: 'xx secret yy', chunk: 4 }],
      outputProcessors: [redactor(/secret/, { lookbackChars: 6 })],
    });
    expect(streamedText(frames).join('')).toBe('xx [redacted] yy');
    expect(streamedText(frames).length).toBeGreaterThan(1);
    expect(JSON.stringify(frames)).not.toContain('secret');
    expect(text).toBe('xx [redacted] yy');
  });

  it('releases behind the LONGEST window in the chain, not the first one it finds', async () => {
    const { frames } = await run({
      turns: [{ text: 'abcdefghij', chunk: 2 }],
      outputProcessors: [passthrough({ lookbackChars: 2 }), passthrough({ lookbackChars: 6 })],
    });
    // Lagging by 6 rather than 2: nothing is released until the 8th character has arrived.
    expect(streamedText(frames)).toEqual(['ab', 'cd', 'efghij']);
  });

  it('fails the run when the whole-answer pass contradicts what was already released', async () => {
    // A window too small for the pattern: 'secret' straddles the released edge, so the final pass
    // produces text that is not an extension of what the reader already has.
    const { error } = await run({
      turns: [{ text: 'xxxxxxxxxx secret', chunk: 4 }],
      outputProcessors: [redactor(/secret/, { lookbackChars: 0 })],
    });
    expect(error).toBeInstanceOf(ProcessorFailedError);
    expect((error as Error).message).toContain('output processor "redact" failed');
    expect((error as Error).message).toContain('already released');
  });

  it('refuses from a prefix, and bills the turn before it raises', async () => {
    const bumps: number[] = [];
    const quota: QuotaStore = {
      check: async () => ({ withinLimit: true, usedTokens: 0, limitTokens: 100 }),
      bump: async (_actorId, _day, tokens) => void bumps.push(tokens),
    };
    const seen: string[] = [];
    const guard: OutputProcessor = {
      name: 'guard',
      incremental: { lookbackChars: 0 },
      process: (answer) => {
        seen.push(answer.text);
        return answer.text.includes('cd')
          ? { action: 'reject', reason: 'forbidden' }
          : { action: 'pass' };
      },
    };
    const { error, frames, usage, stepNames } = await run({
      outputProcessors: [guard],
      quota,
    });
    expect(error).toBeInstanceOf(OutputRejectedError);
    expect(error).toMatchObject({ processor: 'guard', reason: 'forbidden' });
    // Everything after the refusal stayed held — the reader never saw the rest of the answer.
    expect(streamedText(frames).join('')).toBe('ab');
    // The refusal rode the model call's checkpoint, so the gate step returned it instead of putting
    // the whole answer through a chain that has already refused this turn — which for a moderation
    // pass is a second billed call for a decision already made.
    expect(seen).toEqual(['ab', 'abcd']);
    // The refusal rides the model call's own checkpoint, so the accounting steps still run.
    expect(usage.map((row) => row.purpose)).toEqual(['chat']);
    expect(bumps).toHaveLength(1);
    expect(stepNames.slice(stepNames.indexOf('llm:0'))).toEqual([
      'llm:0',
      'process:output:0',
      'persist:usage:0',
      'quota:bump:0',
    ]);
  });

  it('refuses late without un-sending what the reader already has', async () => {
    // The cost of opting in, stated in the docs. A reason that only appears at the end of the
    // answer is still caught — but a prefix has already gone out, and there is no recalling bytes.
    const lateGuard: OutputProcessor = {
      name: 'late-guard',
      incremental: { lookbackChars: 2 },
      process: (answer) =>
        answer.text.endsWith('ij')
          ? { action: 'reject', reason: 'ends badly' }
          : { action: 'pass' },
    };
    const { error, frames, storedText } = await run({ outputProcessors: [lateGuard] });
    expect(error).toBeInstanceOf(OutputRejectedError);
    expect(streamedText(frames).join('')).toBe('abcdef');
    // Nothing was persisted, so the thread's record of the turn is still honest.
    expect(storedText).toBeUndefined();
  });

  it('lets the whole-answer pass refuse what no prefix could', async () => {
    // A step's tool calls are only settled when it ends, so this verdict is unreachable from any
    // prefix — the authoritative pass is what catches it, and it catches it after the release.
    const noToolCalls: OutputProcessor = {
      name: 'no-tool-calls',
      incremental: { lookbackChars: 2 },
      process: (answer) =>
        answer.toolCalls.length > 0
          ? { action: 'reject', reason: 'answer proposes a tool call' }
          : { action: 'pass' },
    };
    const { error, frames } = await run({
      turns: [{ text: 'abcdefghij', toolCall: { id: 'c1', name: 'peek' } }],
      registry: registryWithPeek(),
      outputProcessors: [noToolCalls],
    });
    expect(error).toBeInstanceOf(OutputRejectedError);
    expect(error).toMatchObject({ processor: 'no-tool-calls' });
    expect(streamedText(frames).join('')).toBe('abcdefgh');
  });

  it('does not re-release the prefix after a suspend between the model call and the gate', async () => {
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
    const sink = recordingSink();
    const first = await run({
      outputProcessors: [passthrough({ lookbackChars: 2 })],
      step,
      sink,
      store,
    });
    expect((first.error as Error).message).toBe('suspended before the gate');
    expect(streamedText(sink.frames()).join('')).toBe('abcdefgh');
    const second = await run({
      outputProcessors: [passthrough({ lookbackChars: 2 })],
      step,
      sink,
      store,
    });
    expect(second.error).toBeUndefined();
    // The prefix rode the `llm:0` checkpoint, so the resumed run emits only what it was holding.
    expect(streamedText(sink.frames()).join('')).toBe('abcdefghij');
  });

  it('reads the release from the journal, not from the declaration in force on resume', async () => {
    // Six incidents came from a decision that changed checkpoint shape being read from something
    // other than the journal: a run that suspended under an incremental chain must not re-flush the
    // whole answer just because the chain no longer declares one.
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
    const sink = recordingSink();
    await run({ outputProcessors: [passthrough({ lookbackChars: 2 })], step, sink, store });
    await run({ outputProcessors: [passthrough()], step, sink, store });
    expect(streamedText(sink.frames()).join('')).toBe('abcdefghij');
  });

  it('passes the turn’s tool-call frames through live', async () => {
    const { frames } = await run({
      turns: [{ text: 'abcdefghij', toolCall: { id: 'c1', name: 'peek' } }, { text: 'klmnopqrst' }],
      registry: registryWithPeek(),
      outputProcessors: [passthrough({ lookbackChars: 2 })],
    });
    expect(frames.filter((frame) => frame.kind === 'tool-input-available')).toHaveLength(1);
    expect(streamedText(frames).join('')).toBe('abcdefghijklmnopqrst');
  });

  it('falls back to whole buffering when the model step is dispatched', async () => {
    // A dispatched handler streams into a worker-side sink the loop cannot interpose on, so there
    // is no prefix to release: the envelope asks for the whole answer, exactly as before.
    const envelopes: LlmStepEnvelope[] = [];
    const model = new ChunkedModel([{ text: 'abcdefghij' }]);
    const dispatchLlm = async (
      _index: number,
      envelope: LlmStepEnvelope,
    ): Promise<BufferedModelTurnResult> => {
      envelopes.push(envelope);
      const buffer = createFrameBuffer();
      const result = await model.runTurn({
        system: envelope.system,
        messages: envelope.messages,
        tools: [],
        sink: buffer.writer,
      });
      return { ...result, bufferedFrames: buffer.frames() };
    };
    const { frames } = await run({
      outputProcessors: [passthrough({ lookbackChars: 2 })],
      dispatchLlm,
    });
    expect(envelopes[0]?.bufferOutput).toBe(true);
    expect(streamedText(frames)).toEqual(['abcdefghij']);
  });
});
