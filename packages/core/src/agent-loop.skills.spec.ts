import {
  FakeModelProvider,
  type FakeScript,
  InMemoryAgentStore,
  InMemoryTokenStreamSink,
} from '@dudousxd/nestjs-agent-testing';
import { describe, expect, it } from 'vitest';
import {
  type AgentLoopDeps,
  type AgentLoopHooks,
  DefaultRolesPolicy,
  GLOBAL_SCOPE,
  type ModelTurnArgs,
  type SkillProvider,
  type SkillSummary,
  ToolRegistry,
  runAgentLoop,
} from './index.js';

const RUN_ID = 'run-1';
const ACTOR = { id: 'u1', roles: ['ADMIN'], tenantRef: 'base-7' };
const SKILL_CALL = 'call-0-skill';

/** The durable engine's positional replay contract, reduced to what this file needs. */
class Journal {
  private readonly entries: Array<{ name: string; output: string | undefined }> = [];
  private seq = 0;

  rewind(): void {
    this.seq = 0;
  }

  names(): string[] {
    return this.entries.map((entry) => entry.name);
  }

  /** Drop everything recorded after `name` — a run that suspended at that position. */
  truncateAfter(name: string): void {
    const position = this.entries.findIndex((entry) => entry.name === name);
    if (position === -1) throw new Error(`no entry named ${name}`);
    this.entries.length = position + 1;
  }

  async at<T>(name: string, produce: () => Promise<T>): Promise<T> {
    const position = this.seq;
    this.seq += 1;
    const existing = this.entries[position];
    if (existing !== undefined) {
      if (existing.name !== name) {
        const refusal = new Error(
          `non-determinism at ${RUN_ID}#${position}: code expects "${name}" but history recorded "${existing.name}"`,
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

/** A provider whose bodies a test can change between two passes of the same run. */
function provider(bodies: Record<string, string>, scopes: Record<string, string>): SkillProvider {
  return {
    list: ({ scopes: requested }): SkillSummary[] =>
      Object.keys(bodies)
        .map((name) => ({
          name,
          description: `how to ${name}`,
          scope: scopes[name] ?? 'global',
        }))
        .filter((summary) => requested.includes(summary.scope)),
    load: ({ name }) => bodies[name] ?? null,
  };
}

const loadsASkill: FakeScript = (_args, turnIndex) =>
  turnIndex === 0
    ? { text: 'let me check', toolCall: { name: 'skill', input: { name: 'normalize-unit' } } }
    : { text: 'done' };

interface PassResult {
  names: string[];
  /** Every model call's arguments, in order — what the turn actually put in front of the model. */
  calls: ModelTurnArgs[];
  text: string;
}

async function pass(
  journal: Journal,
  script: FakeScript,
  extra: Partial<AgentLoopDeps> = {},
): Promise<PassResult> {
  const store = new InMemoryAgentStore();
  const sink = new InMemoryTokenStreamSink();
  const thread = await store.createThread({ actor: ACTOR });
  const calls: ModelTurnArgs[] = [];
  const deps: AgentLoopDeps = {
    model: new FakeModelProvider((args, turnIndex) => {
      calls.push(args);
      return script(args, turnIndex);
    }),
    store,
    registry: new ToolRegistry(),
    rolesPolicy: new DefaultRolesPolicy(),
    modelId: 'fake-1',
    day: '2026-09-10',
    systemPrompt: 'You are a test agent.',
    ...extra,
  };
  const hooks: AgentLoopHooks = {
    runId: RUN_ID,
    openSink: () => sink.open(RUN_ID),
    awaitApproval: (call) =>
      journal.at(`signal:tool:${RUN_ID}:${call.id}`, async () => ({ approved: true })),
    step: (name, fn) => journal.at(name, () => fn()),
  };
  journal.rewind();
  const result = await runAgentLoop(
    deps,
    { threadId: thread.id, actor: ACTOR, userText: 'normalize 21 LRS' },
    hooks,
  );
  return { names: journal.names(), calls, text: result.text };
}

describe('agent loop — skills and the turn shape', () => {
  it('adds not one position to a run that configures no skills', async () => {
    const journal = new Journal();
    const { names } = await pass(journal, () => ({ text: 'hi' }));
    expect(names).toEqual([
      'persist:user',
      'load:thread',
      'run:started-at',
      'persist:run:start',
      'stream:step-start:0',
      'llm:0',
      'persist:usage:0',
      'persist:assistant:0',
      'stream:step-finish:0',
      'persist:title',
      'persist:run:end',
    ]);
  });

  it('spends exactly one position on the catalog, before the first model call', async () => {
    const journal = new Journal();
    const { names } = await pass(journal, () => ({ text: 'hi' }), {
      skills: { provider: provider({ 'normalize-unit': 'body' }, {}) },
    });
    expect(names.filter((name) => name.startsWith('skills:'))).toEqual(['skills:catalog']);
    expect(names.indexOf('skills:catalog')).toBeLessThan(names.indexOf('stream:step-start:0'));
  });

  it('serves a loaded skill on a read tool call’s positions, adding no name of its own', async () => {
    const journal = new Journal();
    const { names } = await pass(journal, loadsASkill, {
      skills: { provider: provider({ 'normalize-unit': 'Strip the suffix.' }, {}) },
    });
    expect(names.slice(names.indexOf(`persist:toolcall:${SKILL_CALL}`))).toEqual([
      `persist:toolcall:${SKILL_CALL}`,
      `tool:${SKILL_CALL}`,
      `persist:toolexec:${SKILL_CALL}`,
      'stream:tool-outputs:0',
      'stream:step-finish:0',
      'stream:step-start:1',
      'llm:1',
      'persist:usage:1',
      'persist:assistant:1',
      'stream:step-finish:1',
      'persist:title',
      'persist:run:end',
    ]);
  });
});

describe('agent loop — what skills put in front of the model', () => {
  it('offers the catalog in the system prompt and the tool alongside it', async () => {
    const journal = new Journal();
    const { calls } = await pass(journal, () => ({ text: 'hi' }), {
      skills: {
        provider: provider(
          { 'normalize-unit': 'Strip the suffix.' },
          { 'normalize-unit': 'tenant:base-7' },
        ),
      },
    });
    const first = calls[0];
    expect(first?.system).toContain('- normalize-unit [tenant:base-7] — how to normalize-unit');
    expect(first?.tools.map((tool) => tool.name)).toContain('skill');
  });

  it('keeps the BODY out of the system prompt and puts it on the transcript', async () => {
    const journal = new Journal();
    const { calls } = await pass(journal, loadsASkill, {
      skills: { provider: provider({ 'normalize-unit': 'STRIP-THE-SUFFIX' }, {}) },
    });
    const second = calls[1];
    expect(second?.system).not.toContain('STRIP-THE-SUFFIX');
    expect(JSON.stringify(second?.messages)).toContain('STRIP-THE-SUFFIX');
  });

  it('writes no block when the actor’s scopes yield nothing, but still offers the tool', async () => {
    const journal = new Journal();
    const { calls } = await pass(journal, () => ({ text: 'hi' }), {
      skills: { provider: provider({}, {}) },
    });
    expect(calls[0]?.system).not.toContain('<skills>');
    // The tool's presence is module config, uniform across a deployment — the dispatched llm step
    // re-derives the turn's tool list on a worker that has no catalog, and the two must agree on
    // what was offered. What the model may LOAD comes from the prompt, which is empty here.
    expect(calls[0]?.tools.map((tool) => tool.name)).toContain('skill');
  });

  it('refuses a skill the catalog never offered, as an ordinary tool failure', async () => {
    const journal = new Journal();
    const { names, calls } = await pass(
      journal,
      (_args, turnIndex) =>
        turnIndex === 0
          ? { text: 'peeking', toolCall: { name: 'skill', input: { name: 'someone-elses' } } }
          : { text: 'done' },
      {
        skills: {
          provider: {
            // A provider that hands back a skill from a scope the actor does not have. Only the
            // journaled catalog stands between the model and that body.
            list: () => [{ name: 'someone-elses', description: 'not yours', scope: 'actor:u9' }],
            load: () => 'THE-SECRET',
          },
        },
      },
    );
    expect(names).toContain(`persist:toolfail:${SKILL_CALL}`);
    expect(JSON.stringify(calls[1]?.messages)).not.toContain('THE-SECRET');
    expect(JSON.stringify(calls[1]?.messages)).toContain(
      'No skill named \\"someone-elses\\" is available to you',
    );
  });
});

describe('agent loop — a provider that fails', () => {
  it('records the failure as this call’s outcome and lets the turn carry on', async () => {
    const journal = new Journal();
    const { names, text } = await pass(journal, loadsASkill, {
      skills: {
        provider: {
          list: () => [{ name: 'normalize-unit', description: 'how to', scope: GLOBAL_SCOPE }],
          load: () => {
            throw new Error('the skills table is unreachable');
          },
        },
      },
    });
    expect(names).toContain(`persist:toolfail:${SKILL_CALL}`);
    expect(text).toBe('done');
  });
});

describe('agent loop — which skill body entered the prompt comes out of the journal', () => {
  it('replays the body the first attempt served, not the one this process’s provider now holds', async () => {
    const journal = new Journal();
    const first = await pass(journal, loadsASkill, {
      skills: { provider: provider({ 'normalize-unit': 'VERSION-ONE' }, {}) },
    });
    expect(JSON.stringify(first.calls[1]?.messages)).toContain('VERSION-ONE');

    // The run suspended the moment the body was served, and resumes after someone edited the skill.
    journal.truncateAfter(`tool:${SKILL_CALL}`);
    const replay = await pass(journal, loadsASkill, {
      skills: { provider: provider({ 'normalize-unit': 'VERSION-TWO' }, {}) },
    });
    expect(replay.names).toEqual(first.names);
    // Only the model call after the suspend genuinely ran — and it was shown the journaled body.
    expect(replay.calls).toHaveLength(1);
    expect(JSON.stringify(replay.calls[0]?.messages)).toContain('VERSION-ONE');
    expect(JSON.stringify(replay.calls[0]?.messages)).not.toContain('VERSION-TWO');
  });

  it('replays the same positions in a process whose skills are configured differently', async () => {
    const journal = new Journal();
    const first = await pass(journal, loadsASkill, {
      skills: { provider: provider({ 'normalize-unit': 'VERSION-ONE' }, {}) },
    });

    // A pod that resolves the actor into narrower scopes than the one that started the run — the
    // catalog would be empty here, so a fresh resolution would refuse the call the history executed.
    journal.truncateAfter(`tool:${SKILL_CALL}`);
    const replay = await pass(journal, loadsASkill, {
      skills: {
        provider: provider({}, {}),
        scopes: { resolve: () => ['actor:u1'] },
      },
    });
    expect(replay.names).toEqual(first.names);
    expect(JSON.stringify(replay.calls[0]?.messages)).toContain('VERSION-ONE');
    // And the prompt itself is rebuilt from the journal: this process would have resolved an empty
    // catalog, but the run's system block still carries the one it was started with.
    expect(replay.calls[0]?.system).toContain('- normalize-unit [global]');
  });
});
