import { InMemoryAgentStore, InMemoryTokenStreamSink } from '@dudousxd/nestjs-agent-testing';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  type AgentLoopDeps,
  type AgentLoopHooks,
  DefaultRolesPolicy,
  type HistoryPolicy,
  type ModelProvider,
  type ModelTurnArgs,
  type ModelTurnResult,
  type OutputProcessor,
  OutputRejectedError,
  type ProcessedPrompt,
  ToolRegistry,
  decodeStreamEvent,
  runAgentLoop,
} from './index.js';

const RUN_ID = 'run-1';
const ACTOR = { id: 'u1', roles: ['ADMIN'] };
const REPORT = z.object({ headline: z.string() });

/**
 * Answers prose on the streamed call, and whatever `formatted`/`followUps` say on the two
 * non-streamed calls the loop makes for itself. The three are told apart the way the loop makes
 * them: `outputSchema` set is the formatting pass, and the follow-ups call is the other toolless one.
 */
class ScriptedModel implements ModelProvider {
  readonly seen: ModelTurnArgs[] = [];

  constructor(
    private readonly prose: string,
    private readonly formatted: string,
    private readonly followUps: string[],
  ) {}

  async runTurn(args: ModelTurnArgs): Promise<ModelTurnResult> {
    this.seen.push(args);
    const usage = { inputTokens: 1, outputTokens: 1 };
    if (args.outputSchema !== undefined) {
      return { text: this.formatted, toolCalls: [], usage };
    }
    if (args.system.startsWith('Based on the conversation so far')) {
      return { text: JSON.stringify(this.followUps), toolCalls: [], usage };
    }
    await args.sink.write(
      new TextEncoder().encode(`${JSON.stringify({ kind: 'text', text: this.prose })}\n`),
    );
    return { text: this.prose, toolCalls: [], usage };
  }
}

interface RunOptions {
  processors?: OutputProcessor[];
  prose?: string;
  formatted?: string;
  followUps?: string[];
  outputSchema?: typeof REPORT;
  followUpsCount?: number;
  historyPolicy?: HistoryPolicy;
  inputProcessors?: AgentLoopDeps['inputProcessors'];
  seed?: Array<{ role: 'user' | 'assistant'; content: string }>;
}

async function run(options: RunOptions = {}) {
  const store = new InMemoryAgentStore();
  const sink = new InMemoryTokenStreamSink();
  const thread = await store.createThread({ actor: ACTOR });
  for (const message of options.seed ?? []) {
    await store.appendMessage({ threadId: thread.id, ...message });
  }
  const model = new ScriptedModel(
    options.prose ?? 'the prose answer',
    options.formatted ?? '{"headline":"the structured answer"}',
    options.followUps ?? [],
  );
  const deps: AgentLoopDeps<z.infer<typeof REPORT>> = {
    model,
    store,
    registry: new ToolRegistry(),
    rolesPolicy: new DefaultRolesPolicy(),
    modelId: 'fake-1',
    day: '2026-06-30',
    systemPrompt: 'You are a test agent.',
    ...(options.processors !== undefined ? { outputProcessors: options.processors } : {}),
    ...(options.inputProcessors !== undefined ? { inputProcessors: options.inputProcessors } : {}),
    ...(options.outputSchema !== undefined ? { outputSchema: options.outputSchema } : {}),
    ...(options.followUpsCount !== undefined ? { followUpsCount: options.followUpsCount } : {}),
    ...(options.historyPolicy !== undefined ? { historyPolicy: options.historyPolicy } : {}),
  };
  const stepNames: string[] = [];
  const hooks: AgentLoopHooks = {
    runId: RUN_ID,
    openSink: () => sink.open(RUN_ID),
    awaitApproval: async () => ({ approved: true }),
    step: (name, fn) => {
      stepNames.push(name);
      return fn();
    },
  };
  const outcome = await runAgentLoop(
    deps,
    {
      threadId: thread.id,
      actor: ACTOR,
      userText: 'how many rows?',
    },
    hooks,
  ).then(
    (result) => ({ result, error: undefined }),
    (error: unknown) => ({ result: undefined, error }),
  );
  if (outcome.error !== undefined) {
    // What a runner does with a run that threw: terminate the stream, so a subscriber settles
    // instead of waiting on a turn nobody is running any more.
    (await sink.open(RUN_ID)).fail({ code: 'test', message: 'run failed' });
  }
  const frames: unknown[] = [];
  for await (const chunk of readFrames(sink)) {
    for (const line of new TextDecoder().decode(chunk).split('\n')) {
      if (line.length > 0) {
        const event = decodeStreamEvent(line);
        if (event !== null) {
          frames.push(event);
        }
      }
    }
  }
  const messages = (await store.getThread(thread.id))?.messages ?? [];
  return { outcome, stepNames, frames, messages, model, store };
}

/** Drain a run's stream, tolerating the typed terminal a failed run ends on. */
async function* readFrames(sink: InMemoryTokenStreamSink): AsyncIterable<Uint8Array> {
  try {
    for await (const chunk of sink.subscribe(RUN_ID)) {
      yield chunk;
    }
  } catch {
    /* the run ended with a typed failure — the frames before it are still what reached the reader */
  }
}

/** Rewrites every occurrence of a marker, whatever it is looking at. */
function redactor(marker: string, replacement: string): OutputProcessor {
  return {
    name: 'redactor',
    process: ({ text }) =>
      text.includes(marker)
        ? { action: 'replace', text: text.split(marker).join(replacement) }
        : { action: 'pass' },
  };
}

function refuser(marker: string): OutputProcessor {
  return {
    name: 'refuser',
    process: ({ text }) =>
      text.includes(marker) ? { action: 'reject', reason: `saw ${marker}` } : { action: 'pass' },
  };
}

describe('the output gate over the structured pass', () => {
  it('rewrites the structured answer, not just the prose it restates', async () => {
    const { outcome, messages } = await run({
      processors: [redactor('SECRET', '[redacted]')],
      prose: 'clean prose',
      formatted: '{"headline":"SECRET launch"}',
      outputSchema: REPORT,
    });
    expect(outcome.error).toBeUndefined();
    expect(outcome.result?.object).toEqual({ headline: '[redacted] launch' });
    const structured = messages
      .at(-1)
      ?.toolResults?.find((result) => result.name === 'structured_output');
    expect(structured?.output).toEqual({ headline: '[redacted] launch' });
  });

  it('refuses the run when the chain rejects the structured answer', async () => {
    const { outcome, messages, frames } = await run({
      processors: [refuser('SECRET')],
      prose: 'clean prose',
      formatted: '{"headline":"SECRET launch"}',
      outputSchema: REPORT,
    });
    expect(outcome.error).toBeInstanceOf(OutputRejectedError);
    expect((outcome.error as OutputRejectedError).reason).toBe('saw SECRET');
    // Nothing reached the reader or the transcript: the refused value is never persisted as the
    // synthetic `structured_output` call, and no `tool-output` frame carries it.
    expect(messages.some((message) => JSON.stringify(message).includes('SECRET'))).toBe(false);
    expect(JSON.stringify(frames)).not.toContain('SECRET');
  });

  it('re-parses the gated text rather than trusting a provider-parsed object', async () => {
    const model: ModelProvider = {
      runTurn: async (args) => {
        const usage = { inputTokens: 1, outputTokens: 1 };
        if (args.outputSchema !== undefined) {
          return {
            text: '{"headline":"SECRET launch"}',
            // A provider that constrained generation reports its own parse. It describes the
            // UNGATED answer, so it must not be what the schema validates.
            object: { headline: 'SECRET launch' },
            toolCalls: [],
            usage,
          };
        }
        return { text: 'prose', toolCalls: [], usage };
      },
    };
    const store = new InMemoryAgentStore();
    const thread = await store.createThread({ actor: ACTOR });
    const result = await runAgentLoop<z.infer<typeof REPORT>>(
      {
        model,
        store,
        registry: new ToolRegistry(),
        rolesPolicy: new DefaultRolesPolicy(),
        day: '2026-06-30',
        systemPrompt: 'x',
        outputSchema: REPORT,
        outputProcessors: [redactor('SECRET', '[redacted]')],
      },
      { threadId: thread.id, actor: ACTOR, userText: 'hi' },
      {
        runId: RUN_ID,
        openSink: () => ({ write: () => {}, end: () => {}, fail: () => {} }),
        awaitApproval: async () => ({ approved: true }),
        step: (_name, fn) => fn(),
      },
    );
    expect(result.object).toEqual({ headline: '[redacted] launch' });
  });

  it('adds one checkpoint per formatting attempt, and only when a chain is registered', async () => {
    const gated = await run({
      processors: [redactor('nothing-here', 'x')],
      outputSchema: REPORT,
    });
    expect(gated.stepNames).toContain('process:output:structured:0:0');
    const ungated = await run({ outputSchema: REPORT });
    expect(ungated.stepNames.some((name) => name.startsWith('process:output:structured'))).toBe(
      false,
    );
    // And a chain with no schema gains nothing either — the position exists only where both do.
    const noSchema = await run({ processors: [redactor('nothing-here', 'x')] });
    expect(noSchema.stepNames.some((name) => name.startsWith('process:output:structured'))).toBe(
      false,
    );
  });

  it('runs the whole-answer pass even for a chain that declared itself incremental', async () => {
    const seen: string[] = [];
    const incremental: OutputProcessor = {
      name: 'watcher',
      incremental: { lookbackChars: 4 },
      process: ({ text }) => {
        seen.push(text);
        return { action: 'pass' };
      },
    };
    await run({
      processors: [incremental],
      prose: 'prose',
      formatted: '{"headline":"structured"}',
      outputSchema: REPORT,
    });
    // The formatting pass is never streamed, so there is no prefix to rule on — the chain sees the
    // complete restated answer, exactly once.
    expect(seen.filter((text) => text.includes('structured'))).toEqual([
      '{"headline":"structured"}',
    ]);
  });
});

describe('the output gate over follow-up suggestions', () => {
  it('rewrites a suggestion the chain wants changed', async () => {
    const { messages } = await run({
      processors: [redactor('SECRET', '[redacted]')],
      followUps: ['What about SECRET?', 'What about rows?'],
      followUpsCount: 2,
    });
    expect(messages.at(-1)?.followUps).toEqual(['What about [redacted]?', 'What about rows?']);
  });

  it('drops a refused suggestion and keeps the answer that already passed', async () => {
    const { outcome, messages } = await run({
      processors: [refuser('SECRET')],
      prose: 'clean prose',
      followUps: ['What about SECRET?', 'What about rows?'],
      followUpsCount: 2,
    });
    // The answer cleared the gate on its own; a suggestion nobody asked for must not retract it.
    expect(outcome.error).toBeUndefined();
    expect(outcome.result?.text).toBe('clean prose');
    expect(messages.at(-1)?.followUps).toEqual(['What about rows?']);
  });

  it('adds one checkpoint, and only when a chain is registered', async () => {
    const gated = await run({
      processors: [redactor('nothing-here', 'x')],
      followUps: ['a'],
      followUpsCount: 1,
    });
    expect(gated.stepNames).toContain('process:output:followups:0');
    const ungated = await run({ followUps: ['a'], followUpsCount: 1 });
    expect(ungated.stepNames.some((name) => name.startsWith('process:output:followups'))).toBe(
      false,
    );
  });
});

describe('the folded history summary', () => {
  const policy: HistoryPolicy = {
    select: (messages) => ({ keep: messages.slice(-1), drop: messages.slice(0, -1) }),
    summarize: async () => ({ text: 'earlier, the user mentioned SECRET' }),
  };

  it('is not put through the OUTPUT chain — it is prompt, not an answer', async () => {
    const { outcome, messages } = await run({
      processors: [refuser('SECRET')],
      prose: 'clean prose',
      historyPolicy: policy,
      seed: [
        { role: 'user', content: 'older turn' },
        { role: 'assistant', content: 'older answer' },
      ],
    });
    // A chain that refuses the marker would have ended the run had the summary been gated.
    expect(outcome.error).toBeUndefined();
    expect(messages.at(-1)?.content).toBe('clean prose');
  });

  it('is seen by the INPUT chain instead, which is the seam that owns the prompt', async () => {
    const seen: string[] = [];
    await run({
      historyPolicy: policy,
      inputProcessors: [
        {
          name: 'watcher',
          process: (prompt: ProcessedPrompt) => {
            seen.push(JSON.stringify(prompt.messages));
            return prompt;
          },
        },
      ],
      seed: [
        { role: 'user', content: 'older turn' },
        { role: 'assistant', content: 'older answer' },
      ],
    });
    expect(seen[0]).toContain('earlier, the user mentioned SECRET');
  });
});
