import { InMemoryAgentStore, InMemoryTokenStreamSink } from '@dudousxd/nestjs-agent-testing';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  type AgentLoopDeps,
  type AgentLoopHooks,
  type AgentStreamEvent,
  type AiToolCtx,
  DefaultRolesPolicy,
  type ModelProvider,
  type ModelTurnArgs,
  type ModelTurnResult,
  ToolRegistry,
  createUiCollector,
  decodeStreamEvent,
  encodeStreamEvent,
  runAgentLoop,
  unwrapToolStepOutput,
  wrapToolStepOutput,
} from './index.js';

const RUN_ID = 'run-1';
const ACTOR = { id: 'u1', roles: ['ADMIN'] };

/** Replay journal: positions on the call, JSON round-trip of every output, name checks. */
class Journal {
  readonly entries: Array<{ name: string; output: string | undefined }> = [];
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
        throw new Error(`non-determinism at #${position}: "${name}" vs "${existing.name}"`);
      }
      return (existing.output === undefined ? undefined : JSON.parse(existing.output)) as T;
    }
    const output = await produce();
    const serialized = output === undefined ? undefined : JSON.stringify(output);
    this.entries[position] = { name, output: serialized };
    return (serialized === undefined ? undefined : JSON.parse(serialized)) as T;
  }
}

/**
 * Turn 0 optionally streams its own `ui` frame and asks for `calls`; every later turn answers
 * "done". Counts its turns so a test can tell whether the loop went back to the model.
 */
class ScriptedModel implements ModelProvider {
  turns = 0;
  constructor(
    private readonly calls: { id: string; name: string; input?: unknown }[],
    private readonly modelUi = false,
  ) {}

  async runTurn(args: ModelTurnArgs): Promise<ModelTurnResult> {
    this.turns += 1;
    const first = args.messages.filter((message) => message.role === 'assistant').length === 0;
    if (first && this.modelUi) {
      await args.sink.write(
        encodeStreamEvent({ kind: 'ui', id: 'm1', component: 'Banner', props: { text: 'hi' } }),
      );
    }
    const text = first ? 'looking' : 'done';
    return {
      text,
      toolCalls: first ? this.calls.map((call) => ({ input: {}, ...call })) : [],
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }
}

interface Tool {
  execute: (input: unknown, ctx: AiToolCtx) => Promise<unknown>;
  terminal?: boolean;
}

interface Harness {
  store: InMemoryAgentStore;
  sink: InMemoryTokenStreamSink;
  model: ScriptedModel;
  registry: ToolRegistry;
  threadId: string;
  journal: Journal;
}

async function harness(
  tools: Record<string, Tool>,
  calls: { id: string; name: string; input?: unknown }[],
  modelUi = false,
): Promise<Harness> {
  const store = new InMemoryAgentStore();
  const registry = new ToolRegistry();
  for (const [name, tool] of Object.entries(tools)) {
    registry.register(
      {
        name,
        kind: 'read',
        description: name,
        inputSchema: z.object({}).passthrough(),
        ...(tool.terminal === true ? { terminal: true } : {}),
      },
      { execute: tool.execute },
    );
  }
  const thread = await store.createThread({ actor: ACTOR });
  return {
    store,
    sink: new InMemoryTokenStreamSink(),
    model: new ScriptedModel(calls, modelUi),
    registry,
    threadId: thread.id,
    journal: new Journal(),
  };
}

async function run(
  h: Harness,
  options: {
    dispatched?: boolean;
    resolveUiCatalog?: AgentLoopDeps['resolveUiCatalog'];
    uiCapabilities?: AiToolCtx['uiCapabilities'];
  } = {},
): Promise<string> {
  const deps: AgentLoopDeps = {
    model: h.model,
    store: h.store,
    registry: h.registry,
    rolesPolicy: new DefaultRolesPolicy(),
    modelId: 'fake-1',
    day: '2026-09-29',
    systemPrompt: 'test',
    ...(options.resolveUiCatalog !== undefined
      ? { resolveUiCatalog: options.resolveUiCatalog }
      : {}),
  };
  const hooks: AgentLoopHooks = {
    runId: RUN_ID,
    openSink: () => h.sink.open(RUN_ID),
    awaitApproval: async () => ({ approved: true }),
    step: (name, fn) => h.journal.at(name, fn),
    ...(options.dispatched === true
      ? {
          // What `AgentRunSteps.tool` does on a worker: no live stream here, collect the pushes
          // and hand them back wrapped with the output when the envelope asks for it.
          dispatchTool: (call, envelope) =>
            h.journal.at('agent.tool', async () => {
              const ui = createUiCollector(call.id);
              const output = await h.registry.invoke(
                call.name,
                envelope.input,
                { ...envelope.ctx, emitUi: ui.emit },
                deps.rolesPolicy,
              );
              return envelope.collectUi === true
                ? wrapToolStepOutput(output, ui.components())
                : output;
            }),
        }
      : {}),
  };
  h.journal.rewind();
  const result = await runAgentLoop(
    deps,
    {
      threadId: h.threadId,
      actor: ACTOR,
      userText: 'hi',
      ...(options.uiCapabilities !== undefined ? { uiCapabilities: options.uiCapabilities } : {}),
    },
    hooks,
  );
  return result.text;
}

async function frames(sink: InMemoryTokenStreamSink): Promise<AgentStreamEvent[]> {
  const decoder = new TextDecoder();
  let text = '';
  for await (const chunk of sink.subscribe(RUN_ID)) {
    text += decoder.decode(chunk, { stream: true });
  }
  return text
    .split('\n')
    .map((line) => decodeStreamEvent(line))
    .filter((event): event is AgentStreamEvent => event !== null);
}

async function firstAssistant(h: Harness) {
  const thread = await h.store.getThread(h.threadId);
  return thread?.messages.find((message) => message.role === 'assistant');
}

describe('ctx.emitUi', () => {
  it('journals completed-preflight presentations without executing or duplicating them on replay', async () => {
    const h = await harness({}, [{ id: 'c1', name: 'completed' }]);
    let executions = 0;
    let presentations = 0;
    h.registry.register(
      { name: 'completed', kind: 'action', description: 'completed', inputSchema: z.object({}) },
      {
        execute: async () => {
          executions++;
          return { completed: false };
        },
        preflight: () => ({ status: 'completed', output: { completed: true } }),
        present: () => {
          presentations++;
          return {
            component: 'Banner',
            props: { text: 'Already complete' },
            version: 1,
            fallbackText: 'Already complete',
          };
        },
      },
    );
    await run(h);
    expect(executions).toBe(0);
    expect(presentations).toBe(1);
    expect((await firstAssistant(h))?.ui).toEqual([
      expect.objectContaining({ component: 'Banner', props: { text: 'Already complete' } }),
    ]);
    await run(h);
    expect(executions).toBe(0);
    expect(presentations).toBe(1);
  });
  it('streams the component live, between the call and its output, and persists it on the message', async () => {
    const h = await harness(
      {
        chart: {
          execute: async (_input, ctx) => {
            const { id } = await ctx.emitUi('Chart', { points: [1, 2] }, { version: 2 });
            return { shown: id };
          },
        },
      },
      [{ id: 'c1', name: 'chart' }],
    );
    await run(h);
    const events = await frames(h.sink);
    const ui = events.filter((event) => event.kind === 'ui');
    expect(ui).toEqual([
      {
        kind: 'ui',
        id: 'c1:ui:0',
        component: 'Chart',
        props: { points: [1, 2] },
        version: 2,
        toolCallId: 'c1',
      },
    ]);
    const kinds = events.map((event) => event.kind);
    expect(kinds.indexOf('ui')).toBeLessThan(kinds.indexOf('tool-output'));
    const message = await firstAssistant(h);
    expect(message?.ui).toEqual([
      {
        id: 'c1:ui:0',
        component: 'Chart',
        props: { points: [1, 2] },
        version: 2,
        toolCallId: 'c1',
      },
    ]);
    expect(message?.toolResults?.[0]?.output).toEqual({ shown: 'c1:ui:0' });
  });

  it('updates one component in place when a tool pushes the same id again', async () => {
    const h = await harness(
      {
        table: {
          execute: async (_input, ctx) => {
            await ctx.emitUi('Table', { rows: [1] }, { id: 'rows' });
            await ctx.emitUi('Note', { text: 'loading' });
            await ctx.emitUi('Table', { rows: [1, 2] }, { id: 'rows' });
            return 'ok';
          },
        },
      },
      [{ id: 'c1', name: 'table' }],
    );
    await run(h);
    const message = await firstAssistant(h);
    expect(message?.ui?.map((component) => [component.id, component.props])).toEqual([
      ['rows', { rows: [1, 2] }],
      ['c1:ui:0', { text: 'loading' }],
    ]);
  });

  it('keeps the model turn’s own components first, then the tools’ in call order', async () => {
    const h = await harness(
      {
        a: { execute: async (_input, ctx) => (await ctx.emitUi('A', {}))?.id },
        b: { execute: async (_input, ctx) => (await ctx.emitUi('B', {}))?.id },
      },
      [
        { id: 'c1', name: 'a' },
        { id: 'c2', name: 'b' },
      ],
      true,
    );
    await run(h);
    const message = await firstAssistant(h);
    expect(message?.ui?.map((component) => component.id)).toEqual(['m1', 'c1:ui:0', 'c2:ui:0']);
  });

  it('is replay-safe: a replay neither re-runs the tool, nor re-streams, nor persists twice', async () => {
    let executions = 0;
    const h = await harness(
      {
        chart: {
          execute: async (_input, ctx) => {
            executions += 1;
            await ctx.emitUi('Chart', { n: executions });
            return 'ok';
          },
        },
      },
      [{ id: 'c1', name: 'chart' }],
    );
    await run(h);
    const setUi = h.store.setMessageUi.bind(h.store);
    let persisted = 0;
    h.store.setMessageUi = async (messageId, ui) => {
      persisted += 1;
      await setUi(messageId, ui);
    };
    const before = (await frames(h.sink)).length;
    await run(h);
    expect(executions).toBe(1);
    expect(persisted).toBe(0);
    expect((await frames(h.sink)).length).toBe(before);
    expect((await firstAssistant(h))?.ui).toEqual([
      { id: 'c1:ui:0', component: 'Chart', props: { n: 1 }, toolCallId: 'c1' },
    ]);
    // The journaled tool step carries the pushes with the output.
    const toolStep = h.journal.entries.find((entry) => entry.name === 'tool:c1');
    expect(unwrapToolStepOutput(JSON.parse(toolStep?.output ?? 'null'))).toEqual({
      output: 'ok',
      ui: [{ id: 'c1:ui:0', component: 'Chart', props: { n: 1 }, toolCallId: 'c1' }],
    });
  });

  it('journals the bare output for a tool that pushes nothing (unchanged bytes)', async () => {
    const h = await harness({ plain: { execute: async () => ({ a: 1 }) } }, [
      { id: 'c1', name: 'plain' },
    ]);
    await run(h);
    const toolStep = h.journal.entries.find((entry) => entry.name === 'tool:c1');
    expect(toolStep?.output).toBe('{"a":1}');
    expect((await firstAssistant(h))?.ui).toBeUndefined();
  });

  it('persists what a DISPATCHED tool pushed, read off the step result', async () => {
    const h = await harness(
      { chart: { execute: async (_input, ctx) => (await ctx.emitUi('Chart', { x: 1 }))?.id } },
      [{ id: 'c1', name: 'chart' }],
    );
    await run(h, { dispatched: true });
    const message = await firstAssistant(h);
    expect(message?.ui).toEqual([
      { id: 'c1:ui:0', component: 'Chart', props: { x: 1 }, toolCallId: 'c1' },
    ]);
    expect(message?.toolResults?.[0]?.output).toBe('c1:ui:0');
  });

  it('snapshots props and refuses a non-object', async () => {
    const collector = createUiCollector('c9');
    const props = { rows: [1] };
    await collector.emit('T', props);
    props.rows.push(2);
    expect(collector.components()[0]?.props).toEqual({ rows: [1] });
    await expect(collector.emit('T', [] as unknown as Record<string, unknown>)).rejects.toThrow(
      /JSON object/,
    );
  });
});

describe('ToolSpec.terminal', () => {
  it('ends the turn after a successful terminal call — no further model call', async () => {
    const h = await harness(
      { render: { terminal: true, execute: async () => ({ rendered: true }) } },
      [{ id: 'c1', name: 'render' }],
    );
    const text = await run(h);
    expect(h.model.turns).toBe(1);
    expect(text).toBe('looking');
    const events = await frames(h.sink);
    expect(events.filter((event) => event.kind === 'step-finish')).toHaveLength(1);
    expect(events.find((event) => event.kind === 'tool-output')).toMatchObject({
      id: 'c1',
      output: { rendered: true },
    });
    // The branch is journaled with the call, so a replay takes it too.
    const claim = h.journal.entries.find((entry) => entry.name === 'persist:toolcall:c1');
    expect(JSON.parse(claim?.output ?? '{}')).toMatchObject({ terminal: true });
    await run(h);
    expect(h.model.turns).toBe(1);
  });

  it('does not end the turn when the terminal call fails', async () => {
    const h = await harness(
      {
        render: {
          terminal: true,
          execute: async () => {
            throw new Error('bad tree');
          },
        },
      },
      [{ id: 'c1', name: 'render' }],
    );
    const text = await run(h);
    expect(h.model.turns).toBe(2);
    expect(text).toBe('done');
  });

  it('leaves a non-terminal tool’s turn and journal as they were', async () => {
    const h = await harness({ plain: { execute: async () => 'ok' } }, [
      { id: 'c1', name: 'plain' },
    ]);
    await run(h);
    expect(h.model.turns).toBe(2);
    const claim = h.journal.entries.find((entry) => entry.name === 'persist:toolcall:c1');
    expect(JSON.parse(claim?.output ?? '{}')).toEqual({ kind: 'read' });
  });
});

it('persists safe active fallback text while retaining readable terminal output', async () => {
  const { defineCatalog } = await import('./genui/catalog.js');
  const catalog = defineCatalog([
    {
      name: 'Note',
      title: 'Note',
      description: 'Note',
      props: z.object({ text: z.string() }),
      fallbackText: (props) => String(props.text),
    },
  ]);
  const raw = 'nul\u0000 lone\ud800 emoji😀';
  const h = await harness(
    {
      show: {
        terminal: true,
        execute: async (_input, ctx) => {
          await ctx.emitUi('Note', { text: raw });
          return { shown: true };
        },
      },
    },
    [{ id: 'c1', name: 'show' }],
  );
  const result = await run(h, {
    resolveUiCatalog: () => catalog,
    uiCapabilities: { components: [] },
  });
  const expected = 'nul\\u0000 lone\\ud800 emoji😀';
  expect(result).toContain(expected);
  expect(
    (await h.store.getThread(h.threadId))?.messages.some((message) => message.content === expected),
  ).toBe(true);
});
