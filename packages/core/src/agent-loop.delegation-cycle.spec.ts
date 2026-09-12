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
  DefaultRolesPolicy,
  ToolRegistry,
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

interface CycleRunArgs {
  input?: Partial<AgentRunInput>;
  maxAgentAppearances?: number;
  maxDelegationDepth?: number;
}

/** Runs one turn that delegates to `research`, reporting whether the hop actually happened. */
async function run(args: CycleRunArgs): Promise<{ text: string; delegated: string[] }> {
  const store = new InMemoryAgentStore();
  const sink = new InMemoryTokenStreamSink();
  const thread = await store.createThread({ actor: { id: 'u1', roles: ['ADMIN'] } });
  const delegated: string[] = [];

  const deps: AgentLoopDeps = {
    model: new FakeModelProvider(delegateThenAnswer),
    store,
    registry: buildRegistry(),
    rolesPolicy: new DefaultRolesPolicy(),
    modelId: 'fake-1',
    day: '2026-06-30',
    systemPrompt: 'You are a test agent.',
    ...(args.maxAgentAppearances !== undefined
      ? { maxAgentAppearances: args.maxAgentAppearances }
      : {}),
    ...(args.maxDelegationDepth !== undefined
      ? { maxDelegationDepth: args.maxDelegationDepth }
      : {}),
  };
  const hooks: AgentLoopHooks = {
    runId: 'run-parent',
    openSink: () => sink.open('run-parent'),
    awaitApproval: async () => ({ approved: true }),
    step: async (_name, fn) => fn(),
    runAgent: async (agentName) => {
      delegated.push(agentName);
      return { text: 'THE ANSWER' };
    },
  };
  const result = await runAgentLoop(
    deps,
    {
      threadId: thread.id,
      actor: { id: 'u1', roles: ['ADMIN'] },
      userText: 'go',
      agentName: 'intake',
      ...args.input,
    },
    hooks,
  );
  return { text: result.text, delegated };
}

describe('a delegation chain that has been here before', () => {
  it('refuses the hop that closes the circle, and names the circle', async () => {
    const { text, delegated } = await run({
      input: { delegationPath: ['research'], delegationDepth: 2 },
    });
    expect(delegated).toEqual([]);
    expect(text).toContain('research → intake → research');
    expect(text).toContain('cycle');
  });

  it('counts how many times the agent has been on this chain', async () => {
    const { text } = await run({
      input: { delegationPath: ['research', 'intake', 'research'] },
      maxAgentAppearances: 2,
    });
    expect(text).toContain('research 3 times on one chain');
  });

  it('lets a chain of DISTINCT agents run deeper than a cycle would be allowed to', async () => {
    // Six distinct agents is long, not looping. Under the old depth-only rule this was refused for
    // resembling a cycle; the chain has never reached `research`, so nothing here is circular.
    const { delegated, text } = await run({
      input: {
        delegationPath: ['a', 'b', 'c', 'd', 'e'],
        delegationDepth: 6,
      },
      maxDelegationDepth: 10,
    });
    expect(delegated).toEqual(['research']);
    expect(text).not.toContain('cycle');
  });

  it('still stops a long chain that never repeats, on depth alone', async () => {
    const { delegated, text } = await run({
      input: { delegationPath: ['a', 'b', 'c'], delegationDepth: 4 },
      maxDelegationDepth: 4,
    });
    expect(delegated).toEqual([]);
    expect(text).toContain('depth limit of 4');
  });

  it('names the cycle rather than the depth when a chain trips both', async () => {
    // The depth is the vaguer of the two: it leaves a reader to work out whether the chain was
    // looping or merely long, which is the question the count cannot answer.
    const { text } = await run({
      input: { delegationPath: ['research'], delegationDepth: 9 },
      maxDelegationDepth: 2,
    });
    expect(text).toContain('cycle');
    expect(text).not.toContain('depth limit');
  });

  it('falls back to depth alone when the runner supplies no chain', async () => {
    const { delegated } = await run({ input: { delegationDepth: 0 } });
    expect(delegated).toEqual(['research']);
  });

  it('names the agent that closed the circle, not the one it closed onto twice', async () => {
    // `delegationPath` stops short of the agent running now, so naming the chain from it alone
    // drops the hop being taken: a real alpha→beta→alpha refusal reads `alpha → alpha`, an edge
    // no deployment declares and nothing a reader can find in their config.
    const { text } = await run({
      input: { delegationPath: ['research'], agentName: 'intake' },
    });
    expect(text).toContain('research → intake → research');
  });

  it('catches an agent delegating to ITSELF from a top-level turn', async () => {
    // Nothing has reached this run, so the path is empty; the only thing making this a cycle is
    // the running agent's own name. Read from the path alone it is allowed, and the self-call
    // costs a whole hop before anything notices.
    const { delegated, text } = await run({
      input: { delegationPath: [], agentName: 'research' },
    });
    expect(delegated).toEqual([]);
    expect(text).toContain('research → research');
  });

  it('falls to the depth ceiling once a raised appearance count lets the chain revisit', async () => {
    // The two guards in the same run, with depth winning. Raising appearances is what lets a chain
    // grow past the number of agents it has — without it, a chain cannot outlive the fleet, and a
    // deployment with fewer agents than the ceiling never reaches the ceiling at all.
    const { delegated, text } = await run({
      input: { delegationPath: ['research', 'intake', 'research'], delegationDepth: 3 },
      maxAgentAppearances: 5,
      maxDelegationDepth: 3,
    });
    expect(delegated).toEqual([]);
    expect(text).toContain('depth limit of 3');
    expect(text).not.toContain('cycle');
  });

  it('admits exactly one return when the host allows two appearances', async () => {
    const { delegated } = await run({
      input: { delegationPath: ['research'] },
      maxAgentAppearances: 2,
    });
    expect(delegated).toEqual(['research']);
  });
});
