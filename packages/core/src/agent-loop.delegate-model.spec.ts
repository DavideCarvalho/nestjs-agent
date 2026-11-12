import {
  FakeModelProvider,
  type FakeScript,
  InMemoryAgentStore,
  InMemoryTokenStreamSink,
} from '@dudousxd/nestjs-agent-testing';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  type AgentLoopDeps,
  type AgentLoopHooks,
  DefaultRolesPolicy,
  ToolRegistry,
  namedModels,
  runAgentLoop,
} from './index.js';

function buildRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(
    {
      name: 'ask_research',
      kind: 'agent',
      targetAgent: 'research',
      description: 'delegate and wait',
      inputSchema: z.object({ task: z.string() }),
    },
    { execute: async () => ({}) },
  );
  return registry;
}

const delegateThenAnswer: FakeScript = (args, turnIndex) =>
  turnIndex === 0
    ? { text: 'on it', toolCall: { name: 'ask_research', input: { task: 'dig' } } }
    : {
        text: `saw: ${JSON.stringify((args.messages.at(-1)?.toolResults ?? []).map((r) => r.output))}`,
      };

/** Runs a delegating turn against `journal`, replaying whatever it already holds. */
async function run(
  journal: Map<string, unknown>,
  resolveDelegateModel: AgentLoopDeps['resolveDelegateModel'],
): Promise<{ text: string; delegated: Array<{ agent: string; model?: string }> }> {
  const store = new InMemoryAgentStore();
  const sink = new InMemoryTokenStreamSink();
  const thread = await store.createThread({ actor: { id: 'u1', roles: ['ADMIN'] } });
  const delegated: Array<{ agent: string; model?: string }> = [];
  const deps: AgentLoopDeps = {
    model: new FakeModelProvider(delegateThenAnswer),
    store,
    registry: buildRegistry(),
    rolesPolicy: new DefaultRolesPolicy(),
    day: '2026-11-12',
    systemPrompt: 'You are a test agent.',
    ...(resolveDelegateModel !== undefined ? { resolveDelegateModel } : {}),
  };
  const hooks: AgentLoopHooks = {
    runId: 'run-parent',
    openSink: () => sink.open('run-parent'),
    awaitApproval: async () => ({ approved: true }),
    step: async (name, fn) => {
      if (name.startsWith('persist:toolcall:') && journal.has(name)) {
        return journal.get(name) as never;
      }
      const value = await fn();
      if (name.startsWith('persist:toolcall:')) journal.set(name, value);
      return value;
    },
    runAgent: async (agent, _task, options) => {
      delegated.push({ agent, ...(options?.model !== undefined ? { model: options.model } : {}) });
      return { text: 'THE ANSWER' };
    },
  };
  const result = await runAgentLoop(
    deps,
    {
      threadId: thread.id,
      actor: { id: 'u1', roles: ['ADMIN'] },
      userText: 'go',
      agentName: 'lead',
    },
    hooks,
  );
  return { text: result.text, delegated };
}

describe('the model a delegate runs on', () => {
  it('is the target’s own, resolved once and read back from the journal on a replay', async () => {
    const journal = new Map<string, unknown>();
    const asked: string[] = [];
    let model = 'fast';
    const resolve = async (_actor: unknown, target: string) => {
      asked.push(target);
      return model;
    };
    expect((await run(journal, resolve)).delegated).toEqual([{ agent: 'research', model: 'fast' }]);
    model = 'smart';
    expect((await run(journal, resolve)).delegated).toEqual([{ agent: 'research', model: 'fast' }]);
    expect(asked).toEqual(['research']);
  });

  it('runs on the provider default when nothing resolves', async () => {
    expect((await run(new Map(), async () => undefined)).delegated).toEqual([
      { agent: 'research' },
    ]);
    expect((await run(new Map(), undefined)).delegated).toEqual([{ agent: 'research' }]);
  });

  it('turns a refused model into the tool result, without delegating', async () => {
    const { text, delegated } = await run(new Map(), async () => {
      throw new Error('model "pro" is not available');
    });
    expect(delegated).toEqual([]);
    expect(text).toContain('model \\"pro\\" is not available');
  });
});

describe('namedModels', () => {
  it('routes a turn to the provider its model names, else the default, without the name', async () => {
    const seen: Array<{ name: string; model: string | undefined }> = [];
    const provider = (name: string) =>
      new FakeModelProvider((args) => {
        seen.push({ name, model: args.model });
        return { text: name };
      });
    const named = namedModels(
      { fast: provider('fast'), smart: provider('smart') },
      { default: 'smart' },
    );
    expect(named.names).toEqual(['smart', 'fast']);
    expect(await named.catalog.list({ actor: { id: 'u1', roles: [] } })).toMatchObject({
      default: 'smart',
    });
    const sink = new InMemoryTokenStreamSink();
    const base = {
      system: '',
      messages: [],
      tools: [],
      sink: await sink.open('r'),
      actor: { id: 'u1', roles: [] },
    } as unknown as Parameters<typeof named.runTurn>[0];
    await named.runTurn(base);
    await named.runTurn({ ...base, model: 'fast' });
    await expect(named.runTurn({ ...base, model: 'nope' })).rejects.toThrow(/not configured/);
    expect(seen).toEqual([
      { name: 'smart', model: undefined },
      { name: 'fast', model: undefined },
    ]);
  });
});
