import {
  FakeModelProvider,
  type FakeScript,
  InMemoryAgentStore,
  InMemoryPricingStore,
  InMemoryQuotaStore,
  InMemoryTokenStreamSink,
} from '@dudousxd/nestjs-agent-testing';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  type AgentLoopDeps,
  type AgentLoopHooks,
  type AgentPricingStore,
  type AgentStreamEvent,
  type Decision,
  DefaultRolesPolicy,
  type ModelProvider,
  type PromptBuilder,
  type PromptContributor,
  ToolRegistry,
  runAgentLoop,
} from './index.js';

function buildRegistry(): ToolRegistry {
  const reg = new ToolRegistry();
  reg.register(
    {
      name: 'getWeather',
      kind: 'read',
      description: 'weather',
      inputSchema: z.object({ city: z.string() }),
    },
    { execute: async (input: { city: string }) => ({ tempC: 21, city: input.city }) },
  );
  reg.register(
    {
      name: 'purgeCache',
      kind: 'action',
      description: 'purge',
      inputSchema: z.object({ key: z.string() }),
    },
    { execute: async (input: { key: string }) => ({ purged: input.key }) },
  );
  reg.register(
    {
      name: 'askSub',
      kind: 'agent',
      targetAgent: 'sub-agent',
      description: 'delegate to the sub-agent',
      inputSchema: z.object({ task: z.string() }),
    },
    { execute: async () => ({ text: 'unused — agent-kind tools are loop-handled' }) },
  );
  return reg;
}

async function drain(sink: InMemoryTokenStreamSink, runId: string): Promise<string> {
  const decoder = new TextDecoder();
  let out = '';
  for await (const chunk of sink.subscribe(runId)) {
    out += decoder.decode(chunk);
  }
  return out;
}

/**
 * Parse the NDJSON `AgentStreamEvent`s out of the raw stream. `FakeModelProvider` writes its script's
 * text RAW (no `encodeStreamEvent`/trailing newline — unlike the real ai-sdk adapter), so a text
 * write can end up glued directly onto the following event's line with no separator. Each real event
 * is still newline-terminated at its own end, so scanning each line for the LAST `{"kind":"...` start
 * reliably isolates the JSON tail regardless of what (if anything) is glued in front of it.
 */
function parseEvents(streamed: string): AgentStreamEvent[] {
  const events: AgentStreamEvent[] = [];
  for (const line of streamed.split('\n')) {
    const start = line.lastIndexOf('{"kind":"');
    if (start !== -1) {
      events.push(JSON.parse(line.slice(start)));
    }
  }
  return events;
}

interface RunOverrides {
  systemPrompt?: string | PromptBuilder;
  promptContributors?: PromptContributor[];
  model?: ModelProvider;
  pricingStore?: AgentPricingStore;
}

async function run(
  script: FakeScript,
  decide: (id: string) => Decision = () => ({ approved: true }),
  quota?: InMemoryQuotaStore,
  runAgent?: (agentName: string, task: string) => Promise<{ text: string }>,
  overrides: RunOverrides = {},
) {
  const store = new InMemoryAgentStore();
  const sink = new InMemoryTokenStreamSink();
  const thread = await store.createThread({ actor: { id: 'u1', roles: ['ADMIN'] } });
  const runId = 'run-1';

  const deps: AgentLoopDeps = {
    model: overrides.model ?? new FakeModelProvider(script),
    store,
    registry: buildRegistry(),
    rolesPolicy: new DefaultRolesPolicy(),
    modelId: 'fake-1',
    day: '2026-06-30',
    systemPrompt: overrides.systemPrompt ?? 'You are a test agent.',
    ...(quota !== undefined ? { quota } : {}),
    ...(overrides.promptContributors !== undefined
      ? { promptContributors: overrides.promptContributors }
      : {}),
    ...(overrides.pricingStore !== undefined ? { pricingStore: overrides.pricingStore } : {}),
  };
  const hooks: AgentLoopHooks = {
    runId,
    openSink: () => sink.open(runId),
    awaitApproval: async (call) => decide(call.id),
    step: (_name, fn) => fn(),
    ...(runAgent !== undefined ? { runAgent } : {}),
  };

  const result = await runAgentLoop(
    deps,
    {
      threadId: thread.id,
      actor: { id: 'u1', roles: ['ADMIN'] },
      userText: 'hi',
    },
    hooks,
  );
  const streamed = await drain(sink, runId);
  const detail = await store.getThread(thread.id);
  return { result, streamed, events: parseEvents(streamed), store, detail };
}

describe('runAgentLoop', () => {
  it('streams a no-tool turn and persists user + assistant messages', async () => {
    const { result, streamed, events, detail } = await run(() => ({ text: 'hello world' }));
    expect(result.text).toBe('hello world');
    // The loop brackets the model turn with NDJSON step frames; the model's text streams between them.
    expect(streamed).toContain('{"kind":"step-start"}');
    expect(streamed).toContain('hello world');
    // step-finish now also carries this step's usage/costUsd (Feature 3) — assert on the parsed
    // event rather than a bare-literal substring match, since the frame shape grew.
    expect(events.find((event) => event.kind === 'step-finish')).toMatchObject({
      kind: 'step-finish',
      usage: { inputTokens: 1, outputTokens: 11 },
      costUsd: null,
    });
    expect(detail?.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('auto-executes a read tool then loops to a final answer', async () => {
    const script: FakeScript = (_args, turnIndex) =>
      turnIndex === 0
        ? { text: 'checking', toolCall: { name: 'getWeather', input: { city: 'Recife' } } }
        : { text: 'it is 21C in Recife' };

    const { result, store } = await run(script);
    expect(result.text).toBe('it is 21C in Recife');
    const rows = store.toolCallRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ toolName: 'getWeather', status: 'executed' });
    expect(rows[0]?.output).toEqual({ tempC: 21, city: 'Recife' });
  });

  it('halts an action tool for approval, then executes on approve', async () => {
    const script: FakeScript = (_args, turnIndex) =>
      turnIndex === 0
        ? { text: 'about to purge', toolCall: { name: 'purgeCache', input: { key: 'cfg' } } }
        : { text: 'done' };

    const { store } = await run(script, () => ({ approved: true }));
    const rows = store.toolCallRows();
    expect(rows[0]).toMatchObject({ toolName: 'purgeCache', status: 'executed' });
    expect(rows[0]?.output).toEqual({ purged: 'cfg' });
  });

  it('does not execute an action tool on reject', async () => {
    const script: FakeScript = (_args, turnIndex) =>
      turnIndex === 0
        ? { text: 'about to purge', toolCall: { name: 'purgeCache', input: { key: 'cfg' } } }
        : { text: 'ok, skipped' };

    const { store } = await run(script, () => ({ approved: false, reason: 'nope' }));
    const rows = store.toolCallRows();
    expect(rows[0]).toMatchObject({ toolName: 'purgeCache', status: 'rejected' });
    expect(rows[0]?.output).toBeUndefined();
  });

  it('blocks when over quota', async () => {
    const quota = new InMemoryQuotaStore(0);
    await expect(
      run(
        () => ({ text: 'x' }),
        () => ({ approved: true }),
        quota,
      ),
    ).rejects.toThrow(/quota/i);
  });

  it('records the provider-reported modelId over the configured fallback', async () => {
    const reportingModel: ModelProvider = {
      async runTurn(args) {
        await args.sink.write(new TextEncoder().encode('done'));
        return {
          text: 'done',
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1 },
          modelId: 'claude-real-42',
        };
      },
    };
    // deps.modelId fallback is 'fake-1'; the provider reports a different, authoritative id
    const { store } = await run(() => ({ text: 'unused' }), undefined, undefined, undefined, {
      model: reportingModel,
    });
    expect(store.usageRows()[0]?.modelId).toBe('claude-real-42');
  });

  it('persists a provider-reported costUsd onto the usage row', async () => {
    const gatewayModel: ModelProvider = {
      async runTurn(args) {
        await args.sink.write(new TextEncoder().encode('done'));
        return {
          text: 'done',
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1 },
          // a gateway provider reports the actual spend for this turn
          costUsd: 0.0042,
        };
      },
    };
    const { store } = await run(() => ({ text: 'unused' }), undefined, undefined, undefined, {
      model: gatewayModel,
    });
    expect(store.governanceUsage()[0]?.costUsd).toBeCloseTo(0.0042, 6);
  });

  it('leaves costUsd unset when the provider reports only tokens', async () => {
    const { store } = await run(() => ({ text: 'ok' }));
    expect(store.governanceUsage()[0]?.costUsd).toBeUndefined();
  });

  it('resolves an agent-level PromptBuilder from the turn context', async () => {
    const builder: PromptBuilder = (ctx) => `dynamic prompt for ${ctx.actor.id}`;
    // the fake echoes back whatever system prompt it received, so we can assert resolution
    const { result } = await run(
      (args) => ({ text: args.system }),
      undefined,
      undefined,
      undefined,
      {
        systemPrompt: builder,
      },
    );
    expect(result.text).toBe('dynamic prompt for u1');
  });

  it('composes the base prompt with ordered contributors, skipping null/empty sections', async () => {
    // Exercises both skip paths (`null` and an empty string) alongside two real sections, and
    // asserts contributors run in registration order AFTER the agent's own base prompt.
    const contributors: PromptContributor[] = [
      () => 'Section A: base-scope legend.',
      () => null,
      () => '',
      (ctx) => `Section B: acting for ${ctx.actor.id} as agent "${ctx.agentName}".`,
    ];
    const { result } = await run(
      (args) => ({ text: args.system }),
      undefined,
      undefined,
      undefined,
      {
        systemPrompt: 'Base agent prompt.',
        promptContributors: contributors,
      },
    );
    expect(result.text).toBe(
      'Base agent prompt.' +
        '\n\nSection A: base-scope legend.' +
        '\n\nSection B: acting for u1 as agent "default".',
    );
  });

  it('resolves an async contributor and still honors ordering', async () => {
    const contributors: PromptContributor[] = [
      async (ctx) => `Async section for ${ctx.actor.id}`,
      () => 'Sync section',
    ];
    const { result } = await run(
      (args) => ({ text: args.system }),
      undefined,
      undefined,
      undefined,
      {
        systemPrompt: 'Base.',
        promptContributors: contributors,
      },
    );
    expect(result.text).toBe('Base.\n\nAsync section for u1\n\nSync section');
  });

  it('delegates to a sub-agent via ctx.runAgent and emits agent.delegated', async () => {
    const { subscribe, unsubscribe } = await import('node:diagnostics_channel');
    const { channelName } = await import('@dudousxd/nestjs-diagnostics');
    const delegations: unknown[] = [];
    const channel = channelName('agent', 'delegated');
    const handler = (message: unknown) => delegations.push(message);
    subscribe(channel, handler);

    const script: FakeScript = (_args, turnIndex) =>
      turnIndex === 0
        ? {
            text: 'asking the sub-agent',
            toolCall: { name: 'askSub', input: { task: 'how many bases?' } },
          }
        : { text: 'the sub-agent said hi' };

    try {
      const { result, store } = await run(
        script,
        () => ({ approved: true }),
        undefined,
        async () => ({
          text: 'sub-agent answer: 42',
        }),
      );
      expect(result.text).toBe('the sub-agent said hi');
      expect(store.toolCallRows()[0]).toMatchObject({ toolName: 'askSub', status: 'executed' });
      expect(store.toolCallRows()[0]?.output).toEqual({ text: 'sub-agent answer: 42' });
      expect(delegations).toHaveLength(1);
      expect(delegations[0]).toMatchObject({ payload: { toAgent: 'sub-agent' } });
    } finally {
      unsubscribe(channel, handler);
    }
  });

  it('stamps each persisted tool call with its declared kind (read/action/agent)', async () => {
    const script: FakeScript = (_args, turnIndex) => {
      if (turnIndex === 0) {
        return { text: 'checking', toolCall: { name: 'getWeather', input: { city: 'Recife' } } };
      }
      if (turnIndex === 1) {
        return { text: 'purging', toolCall: { name: 'purgeCache', input: { key: 'cfg' } } };
      }
      return { text: 'done' };
    };
    const { detail } = await run(script);
    const assistantMessages = detail?.messages.filter((m) => m.role === 'assistant') ?? [];
    expect(assistantMessages[0]?.toolCalls?.[0]).toMatchObject({
      name: 'getWeather',
      kind: 'read',
    });
    expect(assistantMessages[1]?.toolCalls?.[0]).toMatchObject({
      name: 'purgeCache',
      kind: 'action',
    });
  });

  it('a call for an unregistered tool name still gets a definite stamped kind (defaults to read)', async () => {
    // Shouldn't happen in practice (the model can only request tools it was offered), but the loop
    // stamps a definite kind rather than leaving it undefined even for a call the registry can't
    // resolve — the call still fails (ToolNotFoundError), just with `kind` present on the record.
    const script: FakeScript = (_args, turnIndex) =>
      turnIndex === 0
        ? { text: 'trying', toolCall: { name: 'ghostTool', input: {} } }
        : { text: 'gave up' };
    const { detail } = await run(script);
    const assistant = detail?.messages.find((m) => m.role === 'assistant');
    expect(assistant?.toolCalls?.[0]).toMatchObject({ name: 'ghostTool', kind: 'read' });
  });

  it('leaves costUsd null on the step-finish frame and stored usage when no pricing store is bound', async () => {
    const { events, detail } = await run(() => ({ text: 'hello' }));
    const stepFinish = events.find((event) => event.kind === 'step-finish');
    expect(stepFinish).toMatchObject({ kind: 'step-finish', costUsd: null });
    const assistant = detail?.messages.find((m) => m.role === 'assistant');
    expect(assistant?.usage?.costUsd).toBeNull();
  });

  it('prices a step from the bound pricing store, cached once per run', async () => {
    const pricingStore = new InMemoryPricingStore();
    await pricingStore.upsertModelPrice({
      modelId: 'fake-1',
      inputPricePer1m: 3,
      outputPricePer1m: 15,
    });
    let listCalls = 0;
    const countingStore: AgentPricingStore = {
      upsertModelPrice: (input) => pricingStore.upsertModelPrice(input),
      listCurrentPrices: () => {
        listCalls += 1;
        return pricingStore.listCurrentPrices();
      },
    };
    // Two tool-round steps + one final step — three messages, ONE price-list fetch for the run.
    const script: FakeScript = (_args, turnIndex) =>
      turnIndex === 0
        ? { text: 'checking', toolCall: { name: 'getWeather', input: { city: 'Recife' } } }
        : { text: 'it is 21C' };
    const { events, detail } = await run(script, undefined, undefined, undefined, {
      pricingStore: countingStore,
    });
    expect(listCalls).toBe(1);
    const stepFinishes = events.filter((event) => event.kind === 'step-finish');
    for (const event of stepFinishes) {
      expect(event.kind === 'step-finish' && typeof event.costUsd === 'number').toBe(true);
    }
    const assistantMessages = detail?.messages.filter((m) => m.role === 'assistant') ?? [];
    for (const message of assistantMessages) {
      expect(typeof message.usage?.costUsd).toBe('number');
    }
  });

  it('an unpriced model stays null even with a pricing store bound (never a fabricated 0)', async () => {
    const pricingStore = new InMemoryPricingStore();
    await pricingStore.upsertModelPrice({
      modelId: 'some-other-model',
      inputPricePer1m: 3,
      outputPricePer1m: 15,
    });
    const { events, detail } = await run(
      () => ({ text: 'hello' }),
      undefined,
      undefined,
      undefined,
      {
        pricingStore,
      },
    );
    const stepFinish = events.find((event) => event.kind === 'step-finish');
    expect(stepFinish).toMatchObject({ kind: 'step-finish', costUsd: null });
    const assistant = detail?.messages.find((m) => m.role === 'assistant');
    expect(assistant?.usage?.costUsd).toBeNull();
  });

  it('a provider-reported costUsd wins over the pricing-store estimate', async () => {
    const pricingStore = new InMemoryPricingStore();
    await pricingStore.upsertModelPrice({
      modelId: 'fake-1',
      inputPricePer1m: 3,
      outputPricePer1m: 15,
    });
    const gatewayModel: ModelProvider = {
      async runTurn(args) {
        await args.sink.write(new TextEncoder().encode('done'));
        return {
          text: 'done',
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1 },
          modelId: 'fake-1',
          costUsd: 0.0042,
        };
      },
    };
    const { events } = await run(() => ({ text: 'unused' }), undefined, undefined, undefined, {
      model: gatewayModel,
      pricingStore,
    });
    const stepFinish = events.find((event) => event.kind === 'step-finish');
    expect(stepFinish).toMatchObject({ kind: 'step-finish', costUsd: 0.0042 });
  });
});
