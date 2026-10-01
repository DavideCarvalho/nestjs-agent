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
  type AgentRunInput,
  type AiToolCtx,
  DefaultRolesPolicy,
  type Persona,
  type PromptContext,
  ToolRegistry,
  runAgentLoop,
} from './index.js';

const RUN_ID = 'run-1';
const ACTOR = { id: 'u1', roles: ['ADMIN'] };

/**
 * Positional checkpoints with JSON round-tripping, as the durable engine keeps them: a name that
 * disagrees with the one recorded at its position is a NonDeterminismError, and nothing passes
 * between two passes except what a checkpoint could carry.
 */
class Journal {
  private readonly entries: Array<{ name: string; output: string | undefined }> = [];
  private seq = 0;

  rewind(): void {
    this.seq = 0;
  }

  names(): string[] {
    return this.entries.map((entry) => entry.name);
  }

  /** Drop everything from `position` on — a run that suspended there. */
  truncate(position: number): void {
    this.entries.length = position;
  }

  async at<T>(name: string, produce: () => Promise<T>): Promise<T> {
    const position = this.seq;
    this.seq += 1;
    const existing = this.entries[position];
    if (existing !== undefined) {
      if (existing.name !== name) {
        const refusal = new Error(
          `non-determinism at #${position}: code expects "${name}" but history recorded "${existing.name}"`,
        );
        refusal.name = 'NonDeterminismError';
        throw refusal;
      }
      return (existing.output === undefined ? undefined : JSON.parse(existing.output)) as T;
    }
    const output = await produce();
    const serialized = output === undefined ? undefined : JSON.stringify(output);
    this.entries[position] = { name, output: serialized };
    return (serialized === undefined ? undefined : JSON.parse(serialized)) as T;
  }
}

/** Three read tools any role reaches, so only allow-lists decide what is offered. */
function registry(executed: string[] = [], seenCtx: AiToolCtx[] = []): ToolRegistry {
  const reg = new ToolRegistry();
  for (const name of ['alpha', 'beta', 'gamma']) {
    reg.register(
      { name, kind: 'read', description: name, inputSchema: z.object({}) },
      {
        execute: async (_input: unknown, ctx: AiToolCtx) => {
          executed.push(name);
          seenCtx.push(ctx);
          return { ran: name };
        },
      },
    );
  }
  return reg;
}

interface RunOptions {
  script?: FakeScript;
  deps?: Partial<AgentLoopDeps>;
  input?: Partial<AgentRunInput>;
  journal?: Journal;
  store?: InMemoryAgentStore;
  threadId?: string;
  executed?: string[];
  seenCtx?: AiToolCtx[];
}

async function run(options: RunOptions = {}) {
  const store = options.store ?? new InMemoryAgentStore();
  const sink = new InMemoryTokenStreamSink();
  const threadId = options.threadId ?? (await store.createThread({ actor: ACTOR })).id;
  const seen: Array<{ system: string; tools: string[] }> = [];
  const script: FakeScript = options.script ?? (() => ({ text: 'ok' }));
  const model = new FakeModelProvider((args, turn) => {
    seen.push({ system: args.system, tools: args.tools.map((tool) => tool.name) });
    return script(args, turn);
  });
  const deps: AgentLoopDeps = {
    model,
    store,
    registry: registry(options.executed, options.seenCtx),
    rolesPolicy: new DefaultRolesPolicy(),
    modelId: 'fake-1',
    day: '2026-09-30',
    systemPrompt: 'Base agent prompt.',
    ...options.deps,
  };
  const journal = options.journal;
  journal?.rewind();
  const hooks: AgentLoopHooks = {
    runId: RUN_ID,
    openSink: () => sink.open(RUN_ID),
    awaitApproval: async () => ({ approved: true }),
    step: journal === undefined ? (_name, fn) => fn() : (name, fn) => journal.at(name, () => fn()),
  };
  const result = await runAgentLoop(
    deps,
    { threadId, actor: ACTOR, userText: 'hi', ...options.input },
    hooks,
  );
  return { result, seen, store, threadId };
}

const ANALYST: Persona = {
  id: 'analyst',
  label: 'Analyst',
  systemPrompt: (ctx) => `${ctx.basePrompt}\n\nActing as analyst for ${ctx.actor.id}.`,
};

describe('agent loop — personas (the prompt)', () => {
  it('lets a persona PromptBuilder wrap the agent base prompt', async () => {
    const { seen } = await run({
      deps: { personas: [ANALYST] },
      input: { persona: 'analyst' },
    });
    expect(seen[0]?.system).toBe('Base agent prompt.\n\nActing as analyst for u1.');
  });

  it('a flat persona prompt stands in for the base prompt, as in the Adonis port', async () => {
    const { seen } = await run({
      deps: {
        personas: [{ id: 'terse', label: 'Terse', systemPrompt: 'Answer in one line.' }],
      },
      input: { persona: 'terse' },
    });
    expect(seen[0]?.system).toBe('Answer in one line.');
  });

  it('keeps the cross-agent contributors after the persona prompt, and shows them the persona', async () => {
    const contexts: PromptContext[] = [];
    const { seen } = await run({
      deps: {
        personas: [ANALYST],
        promptContributors: [
          (ctx) => {
            contexts.push(ctx);
            return `contributor sees ${ctx.persona?.id ?? 'none'}`;
          },
        ],
      },
      input: { persona: 'analyst' },
    });
    expect(seen[0]?.system).toBe(
      'Base agent prompt.\n\nActing as analyst for u1.\n\ncontributor sees analyst',
    );
    expect(contexts[0]?.persona).toEqual({ id: 'analyst', label: 'Analyst' });
  });

  it('a persona without a prompt keeps the base prompt, which can read the persona itself', async () => {
    const { seen } = await run({
      deps: {
        systemPrompt: (ctx) => `base for ${ctx.persona?.label ?? 'nobody'}`,
        personas: [{ id: 'sql', label: 'SQL focused' }],
      },
      input: { persona: 'sql' },
    });
    expect(seen[0]?.system).toBe('base for SQL focused');
  });

  it('runs on the base prompt alone when the turn names no persona', async () => {
    const { seen } = await run({ deps: { personas: [ANALYST] } });
    expect(seen[0]?.system).toBe('Base agent prompt.');
  });
});

describe('agent loop — personas (the tool allow-list)', () => {
  it('offers only the persona allow-list, after the agent allow-list', async () => {
    const { seen } = await run({
      deps: {
        toolAllowList: ['alpha', 'beta'],
        personas: [{ id: 'narrow', label: 'Narrow', allowedTools: ['beta', 'gamma'] }],
      },
      input: { persona: 'narrow' },
    });
    // gamma is the persona's but not the agent's; alpha the agent's but not the persona's.
    expect(seen[0]?.tools).toEqual(['beta']);
  });

  it('a persona with no allow-list leaves the agent offer as it was', async () => {
    const { seen } = await run({
      deps: { personas: [{ id: 'open', label: 'Open' }] },
      input: { persona: 'open' },
    });
    expect(seen[0]?.tools).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('refuses a call to a tool the persona was not offered, even when the model names it', async () => {
    const executed: string[] = [];
    const { store } = await run({
      executed,
      deps: { personas: [{ id: 'narrow', label: 'Narrow', allowedTools: ['beta'] }] },
      input: { persona: 'narrow' },
      script: (_args, turn) =>
        turn === 0 ? { text: 'trying', toolCall: { name: 'alpha', input: {} } } : { text: 'ok' },
    });
    expect(executed).toEqual([]);
    expect(store.toolCallRows()[0]).toMatchObject({ toolName: 'alpha', status: 'failed' });
  });

  it('still runs a tool on the persona list', async () => {
    const executed: string[] = [];
    await run({
      executed,
      deps: { personas: [{ id: 'narrow', label: 'Narrow', allowedTools: ['beta'] }] },
      input: { persona: 'narrow' },
      script: (_args, turn) =>
        turn === 0 ? { text: 'trying', toolCall: { name: 'beta', input: {} } } : { text: 'ok' },
    });
    expect(executed).toEqual(['beta']);
  });

  it('hands the tool the persona it runs under', async () => {
    const seenCtx: AiToolCtx[] = [];
    await run({
      seenCtx,
      deps: { personas: [{ id: 'open', label: 'Open' }] },
      input: { persona: 'open' },
      script: (_args, turn) =>
        turn === 0 ? { text: 'trying', toolCall: { name: 'beta', input: {} } } : { text: 'ok' },
    });
    expect(seenCtx[0]?.persona).toBe('open');
  });
});

describe('agent loop — personas (delegation)', () => {
  it('refuses a handoff the persona was not offered, without starting the delegate', async () => {
    const store = new InMemoryAgentStore();
    const sink = new InMemoryTokenStreamSink();
    const thread = await store.createThread({ actor: ACTOR });
    const reg = registry();
    reg.register(
      {
        name: 'ask_helper',
        kind: 'agent',
        targetAgent: 'helper',
        description: 'ask the helper',
        inputSchema: z.object({ task: z.string() }),
      },
      { execute: async () => ({}) },
    );
    const delegated: string[] = [];
    const deps: AgentLoopDeps = {
      model: new FakeModelProvider((_args, turn) =>
        turn === 0
          ? { text: 'asking', toolCall: { name: 'ask_helper', input: { task: 'x' } } }
          : { text: 'ok' },
      ),
      store,
      registry: reg,
      rolesPolicy: new DefaultRolesPolicy(),
      day: '2026-09-30',
      systemPrompt: 'base',
      personas: [{ id: 'narrow', label: 'Narrow', allowedTools: ['beta'] }],
    };
    const hooks: AgentLoopHooks = {
      runId: RUN_ID,
      openSink: () => sink.open(RUN_ID),
      awaitApproval: async () => ({ approved: true }),
      step: (_name, fn) => fn(),
      runAgent: async (agentName) => {
        delegated.push(agentName);
        return { text: 'helped' };
      },
    };
    await runAgentLoop(
      deps,
      { threadId: thread.id, actor: ACTOR, userText: 'hi', persona: 'narrow' },
      hooks,
    );
    expect(delegated).toEqual([]);
    const call = (await store.getThread(thread.id))?.messages
      .flatMap((message) => message.toolResults ?? [])
      .find((result) => result.name === 'ask_helper');
    expect(JSON.stringify(call?.output)).toContain('not available to the \\"narrow\\" persona');
  });
});

describe('agent loop — personas (provenance)', () => {
  it('records the persona on the turn’s user and assistant messages', async () => {
    const { store, threadId } = await run({
      deps: { personas: [ANALYST] },
      input: { persona: 'analyst' },
    });
    const messages = (await store.getThread(threadId))?.messages ?? [];
    expect(messages.map((message) => [message.role, message.persona])).toEqual([
      ['user', 'analyst'],
      ['assistant', 'analyst'],
    ]);
  });

  it('records no persona on a turn that has none', async () => {
    const { store, threadId } = await run({ deps: { personas: [ANALYST] } });
    const messages = (await store.getThread(threadId))?.messages ?? [];
    expect(messages.every((message) => message.persona === undefined)).toBe(true);
  });

  it('runs without a persona when the one the turn names is no longer declared', async () => {
    const { seen, store, threadId } = await run({
      deps: { personas: [ANALYST] },
      input: { persona: 'retired' },
    });
    expect(seen[0]?.system).toBe('Base agent prompt.');
    expect(seen[0]?.tools).toEqual(['alpha', 'beta', 'gamma']);
    const messages = (await store.getThread(threadId))?.messages ?? [];
    expect(messages.every((message) => message.persona === undefined)).toBe(true);
  });
});

describe('agent loop — personas under replay', () => {
  it('journals the persona the turn resolved, ahead of every other checkpoint', async () => {
    const journal = new Journal();
    await run({ journal, deps: { personas: [ANALYST] }, input: { persona: 'analyst' } });
    expect(journal.names()[0]).toBe('persona:resolve');
  });

  it('spends no checkpoint on a turn without a persona — the sequence a run before personas had', async () => {
    const without = new Journal();
    await run({ journal: without });
    const withPersonasDeclared = new Journal();
    await run({ journal: withPersonasDeclared, deps: { personas: [ANALYST] } });
    expect(withPersonasDeclared.names()).toEqual(without.names());
    expect(without.names()).not.toContain('persona:resolve');
  });

  it('replays on the persona it recorded after the persona’s config changed under it', async () => {
    const journal = new Journal();
    const store = new InMemoryAgentStore();
    const threadId = (await store.createThread({ actor: ACTOR })).id;
    const narrow: Persona = {
      id: 'narrow',
      label: 'Narrow',
      systemPrompt: 'Narrow prompt v1.',
      allowedTools: ['beta'],
    };
    const script: FakeScript = (_args, turn) =>
      turn === 0 ? { text: 'trying', toolCall: { name: 'beta', input: {} } } : { text: 'ok' };
    await run({
      journal,
      store,
      threadId,
      script,
      deps: { personas: [narrow] },
      input: { persona: 'narrow' },
    });

    // Suspend the run right after the tool executed — everything from the second model call on is
    // still to come — then resume it on a process whose persona has been rewritten.
    const names = journal.names();
    journal.truncate(names.indexOf('llm:1'));
    const rewritten: Persona = {
      id: 'narrow',
      label: 'Narrow',
      systemPrompt: 'Narrow prompt v2.',
      allowedTools: ['alpha'],
    };
    const { seen } = await run({
      journal,
      store,
      threadId,
      script,
      deps: { personas: [rewritten] },
      input: { persona: 'narrow' },
    });
    // The resumed model call is the second one the turn makes: on the recorded prompt and offer.
    expect(seen.at(-1)?.system).toBe('Narrow prompt v1.');
    expect(seen.at(-1)?.tools).toEqual(['beta']);
  });

  it('replays on the persona it recorded after the persona was removed', async () => {
    const journal = new Journal();
    const store = new InMemoryAgentStore();
    const threadId = (await store.createThread({ actor: ACTOR })).id;
    await run({
      journal,
      store,
      threadId,
      deps: { personas: [ANALYST] },
      input: { persona: 'analyst' },
    });
    journal.truncate(journal.names().indexOf('llm:0'));
    const { seen } = await run({ journal, store, threadId, input: { persona: 'analyst' } });
    expect(seen.at(-1)?.system).toBe('Base agent prompt.\n\nActing as analyst for u1.');
  });
});
