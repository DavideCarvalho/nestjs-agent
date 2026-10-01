import {
  FakeModelProvider,
  InMemoryAgentStore,
  InMemoryTokenStreamSink,
} from '@dudousxd/nestjs-agent-testing';
import { describe, expect, it } from 'vitest';
import {
  type AgentLoopDeps,
  type AgentLoopHooks,
  DefaultRolesPolicy,
  type LlmStepEnvelope,
  type RecordUsageInput,
  ToolRegistry,
  decodeStreamEvent,
  findCatalogModel,
  runAgentLoop,
  staticModelCatalog,
} from './index.js';

class RecordingStore extends InMemoryAgentStore {
  readonly usageInputs: RecordUsageInput[] = [];

  override async recordUsage(input: RecordUsageInput): Promise<void> {
    this.usageInputs.push(input);
    await super.recordUsage(input);
  }
}

async function run(model: string | undefined, dispatch = false) {
  const store = new RecordingStore();
  const sink = new InMemoryTokenStreamSink();
  const thread = await store.createThread({ actor: { id: 'u1' } });
  const seen: Array<string | undefined> = [];
  const envelopes: LlmStepEnvelope[] = [];
  const provider = new FakeModelProvider((args) => {
    seen.push(args.model);
    return { text: 'answered' };
  });
  const deps: AgentLoopDeps = {
    model: provider,
    store,
    registry: new ToolRegistry(),
    rolesPolicy: new DefaultRolesPolicy(),
    modelId: 'agent-label',
    day: '2026-06-30',
    systemPrompt: 'test',
    followUpsCount: 2,
  };
  const hooks: AgentLoopHooks = {
    runId: 'run-1',
    openSink: () => sink.open('run-1'),
    awaitApproval: async () => ({ approved: true }),
    step: (_name, fn) => fn(),
    ...(dispatch
      ? {
          dispatchLlm: async (_index: number, envelope: LlmStepEnvelope) => {
            envelopes.push(envelope);
            return provider.runTurn({
              system: envelope.system,
              messages: envelope.messages,
              tools: [],
              sink: await sink.open('run-1'),
              ...(envelope.model !== undefined ? { model: envelope.model } : {}),
            });
          },
        }
      : {}),
  };
  await runAgentLoop(
    deps,
    {
      threadId: thread.id,
      actor: { id: 'u1' },
      userText: 'hi',
      ...(model !== undefined ? { model } : {}),
    },
    hooks,
  );
  return { seen, usage: store.usageInputs, envelopes, frames: await frames(sink) };
}

/** Every stream frame the run wrote (the fake model also writes bare text chunks, skipped). */
async function frames(sink: InMemoryTokenStreamSink): Promise<Record<string, unknown>[]> {
  const decoder = new TextDecoder();
  const out: Record<string, unknown>[] = [];
  for await (const chunk of sink.subscribe('run-1')) {
    const event = decodeStreamEvent(decoder.decode(chunk).trim());
    if (event !== null) {
      out.push(event as unknown as Record<string, unknown>);
    }
  }
  return out;
}

describe('agent loop — the selected model', () => {
  it('runs every call of the turn on the selected model and labels usage with it', async () => {
    const { seen, usage } = await run('gpt-fast');
    // the answer and the follow-up suggestions
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(new Set(seen)).toEqual(new Set(['gpt-fast']));
    expect(usage.map((entry) => entry.modelId)).toEqual(usage.map(() => 'gpt-fast'));
  });

  it("leaves the provider's default alone when no model was selected", async () => {
    const { seen, usage } = await run(undefined);
    expect(new Set(seen)).toEqual(new Set([undefined]));
    expect(usage[0]?.modelId).toBe('agent-label');
  });

  it('names the model on every step-finish frame — the selected one, else the configured label', async () => {
    const selected = await run('gpt-fast');
    const finishes = selected.frames.filter((frame) => frame.kind === 'step-finish');
    expect(finishes.length).toBeGreaterThan(0);
    expect(finishes.map((frame) => frame.model)).toEqual(finishes.map(() => 'gpt-fast'));
    const fallback = await run(undefined);
    expect(fallback.frames.find((frame) => frame.kind === 'step-finish')?.model).toBe(
      'agent-label',
    );
  });

  it('carries the selected model on a dispatched step envelope', async () => {
    const { envelopes, seen } = await run('gpt-fast', true);
    expect(envelopes[0]?.model).toBe('gpt-fast');
    expect(seen[0]).toBe('gpt-fast');
  });
});

describe('staticModelCatalog', () => {
  it('answers its view and finds an entry by id across providers', async () => {
    const catalog = staticModelCatalog({
      default: 'b',
      providers: [
        { id: 'p1', label: 'P1', models: [{ id: 'a', label: 'A', available: true }] },
        { id: 'p2', label: 'P2', models: [{ id: 'b', label: 'B', available: false }] },
      ],
    });
    const view = await catalog.list({ actor: { id: 'u1' } });
    expect(findCatalogModel(view, 'b')?.label).toBe('B');
    expect(findCatalogModel(view, 'zzz')).toBeUndefined();
  });
});
