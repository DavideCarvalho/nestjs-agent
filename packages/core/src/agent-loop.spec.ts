import {
  FakeModelProvider,
  type FakeScript,
  InMemoryAgentStore,
  InMemoryQuotaStore,
  InMemoryTokenStreamSink,
} from '@dudousxd/nestjs-agent-testing';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  type AgentLoopDeps,
  type AgentLoopHooks,
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

interface RunOverrides {
  systemPrompt?: string | PromptBuilder;
  promptContributors?: PromptContributor[];
  model?: ModelProvider;
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
  return { result, streamed, store, detail };
}

describe('runAgentLoop', () => {
  it('streams a no-tool turn and persists user + assistant messages', async () => {
    const { result, streamed, detail } = await run(() => ({ text: 'hello world' }));
    expect(result.text).toBe('hello world');
    expect(streamed).toBe('hello world');
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
});
