import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  FakeModelProvider,
  InMemoryAgentStore,
  InMemoryQuotaStore,
  InMemoryTokenStreamSink,
  type FakeScript,
} from '@dudousxd/nestjs-agent-testing';
import {
  DefaultRolesPolicy,
  ToolRegistry,
  runAgentLoop,
  type AgentLoopDeps,
  type AgentLoopHooks,
  type Decision,
} from './index.js';

function buildRegistry(): ToolRegistry {
  const reg = new ToolRegistry();
  reg.register(
    { name: 'getWeather', kind: 'read', description: 'weather', inputSchema: z.object({ city: z.string() }) },
    { execute: async (input: { city: string }) => ({ tempC: 21, city: input.city }) },
  );
  reg.register(
    { name: 'purgeCache', kind: 'action', description: 'purge', inputSchema: z.object({ key: z.string() }) },
    { execute: async (input: { key: string }) => ({ purged: input.key }) },
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

async function run(
  script: FakeScript,
  decide: (id: string) => Decision = () => ({ approved: true }),
  quota?: InMemoryQuotaStore,
) {
  const store = new InMemoryAgentStore();
  const sink = new InMemoryTokenStreamSink();
  const thread = await store.createThread({ actor: { id: 'u1', role: 'ADMIN' }, persona: 'default' });
  const runId = 'run-1';

  const deps: AgentLoopDeps = {
    model: new FakeModelProvider(script),
    store,
    registry: buildRegistry(),
    rolesPolicy: new DefaultRolesPolicy(),
    modelId: 'fake-1',
    day: '2026-06-30',
    systemPrompt: 'You are a test agent.',
    ...(quota !== undefined ? { quota } : {}),
  };
  const hooks: AgentLoopHooks = {
    runId,
    openSink: () => sink.open(runId),
    awaitApproval: async (call) => decide(call.id),
    step: (_name, fn) => fn(),
  };

  const result = await runAgentLoop(deps, { threadId: thread.id, actor: { id: 'u1', role: 'ADMIN' }, userText: 'hi' }, hooks);
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
    await expect(run(() => ({ text: 'x' }), () => ({ approved: true }), quota)).rejects.toThrow(
      /quota/i,
    );
  });
});
