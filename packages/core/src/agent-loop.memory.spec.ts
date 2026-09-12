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
  type MemoryProvider,
  type MemoryRecord,
  type ModelTurnArgs,
  ToolRegistry,
  runAgentLoop,
} from './index.js';

const RUN_ID = 'run-1';
const ACTOR = { id: 'u1', roles: ['ADMIN'], tenantRef: 'berlin' };
const REMEMBER_CALL = 'call-0-remember';

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

function fact(key: string, scope: string, text: string): MemoryRecord {
  return {
    id: `${scope}/${key}`,
    key,
    text,
    scope,
    origin: { author: 'agent', threadId: 't0', runId: 'r0', actorRef: 'u1' },
    updatedAt: '2026-09-01T00:00:00.000Z',
  };
}

/** A provider over a mutable row set, so a test can watch what a turn wrote. */
function provider(rows: MemoryRecord[], writable = true): MemoryProvider {
  const base: MemoryProvider = {
    list: ({ scopes }) => rows.filter((row) => scopes.includes(row.scope)),
    forget: ({ id }) => {
      const index = rows.findIndex((row) => row.id === id);
      if (index === -1) return false;
      rows.splice(index, 1);
      return true;
    },
  };
  return writable
    ? {
        ...base,
        write: (input) => {
          const saved: MemoryRecord = {
            id: `${input.scope}/${input.key}`,
            key: input.key,
            text: input.text,
            scope: input.scope,
            origin: input.origin,
            updatedAt: '2026-09-10T12:00:00.000Z',
          };
          rows.push(saved);
          return saved;
        },
      }
    : base;
}

const writesAMemory: FakeScript = (_args, turnIndex) =>
  turnIndex === 0
    ? {
        text: 'noted',
        toolCall: {
          name: 'remember',
          input: { key: 'units', fact: 'they report distances in nautical miles' },
        },
      }
    : { text: 'done' };

interface PassResult {
  names: string[];
  calls: ModelTurnArgs[];
  text: string;
}

async function pass(
  journal: Journal,
  script: FakeScript,
  extra: Partial<AgentLoopDeps> = {},
  userText = 'how far is it',
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
  const result = await runAgentLoop(deps, { threadId: thread.id, actor: ACTOR, userText }, hooks);
  return { names: journal.names(), calls, text: result.text };
}

describe('agent loop — memory and the turn shape', () => {
  it('adds not one position to a run that configures no memory', async () => {
    const journal = new Journal();
    const { names } = await pass(journal, () => ({ text: 'hi' }));
    expect(names).toEqual([
      'persist:user',
      'load:thread',
      'run:prompt-stages',
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

  it('spends exactly one position on the digest, after the run row and before the first model call', async () => {
    const journal = new Journal();
    const { names } = await pass(journal, () => ({ text: 'hi' }), {
      memory: { provider: provider([fact('units', GLOBAL_SCOPE, 'nautical miles')]) },
    });
    expect(names.filter((name) => name.startsWith('memory:'))).toEqual(['memory:digest']);
    // After the run row, so `promptHash` keeps identifying the prompt VERSION rather than a person.
    expect(names.indexOf('memory:digest')).toBeGreaterThan(names.indexOf('persist:run:start'));
    expect(names.indexOf('memory:digest')).toBeLessThan(names.indexOf('stream:step-start:0'));
  });

  it('serves a `remember` call on a read tool call’s positions, adding no name of its own', async () => {
    const journal = new Journal();
    const { names } = await pass(journal, writesAMemory, {
      memory: { provider: provider([]) },
    });
    expect(names.slice(names.indexOf(`persist:toolcall:${REMEMBER_CALL}`))).toEqual([
      `persist:toolcall:${REMEMBER_CALL}`,
      `tool:${REMEMBER_CALL}`,
      `persist:toolexec:${REMEMBER_CALL}`,
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

describe('agent loop — what memory puts in front of the model', () => {
  it('writes the block into the system prompt and offers the tool alongside it', async () => {
    const journal = new Journal();
    const { calls } = await pass(journal, () => ({ text: 'hi' }), {
      memory: { provider: provider([fact('units', 'tenant:berlin', 'nautical miles')]) },
    });
    expect(calls[0]?.system).toContain('- [tenant:berlin] units: nautical miles');
    expect(calls[0]?.tools.map((tool) => tool.name)).toContain('remember');
  });

  it('shows the model the value a narrower scope beat, not merely that it beat one', async () => {
    const journal = new Journal();
    const { calls } = await pass(journal, () => ({ text: 'hi' }), {
      memory: {
        provider: provider([
          fact('fiscal-year', GLOBAL_SCOPE, 'starts in October'),
          fact('fiscal-year', 'actor:u1', 'they use the calendar year'),
        ]),
      },
    });
    expect(calls[0]?.system).toContain('- [actor:u1] fiscal-year: they use the calendar year');
    expect(calls[0]?.system).toContain('[global] instead has: starts in October');
  });

  it('places memory above the skills catalog, so instructions precede the menu', async () => {
    const journal = new Journal();
    const { calls } = await pass(journal, () => ({ text: 'hi' }), {
      memory: { provider: provider([fact('units', GLOBAL_SCOPE, 'nautical miles')]) },
      skills: {
        provider: {
          list: () => [{ name: 'label-pallet', description: 'how to', scope: GLOBAL_SCOPE }],
          load: () => 'body',
        },
      },
    });
    const system = calls[0]?.system ?? '';
    expect(system.indexOf('<memory>')).toBeGreaterThan(-1);
    expect(system.indexOf('<memory>')).toBeLessThan(system.indexOf('<skills>'));
  });

  it('writes no block when the actor has no memories, but still offers the tool', async () => {
    const journal = new Journal();
    const { calls } = await pass(journal, () => ({ text: 'hi' }), {
      memory: { provider: provider([]) },
    });
    expect(calls[0]?.system).not.toContain('<memory>');
    // The tool's presence is module config, uniform across a deployment — the dispatched llm step
    // re-derives the turn's tool list on a worker that has no digest, and the two must agree.
    expect(calls[0]?.tools.map((tool) => tool.name)).toContain('remember');
  });

  it('never offers the tool where the provider cannot write', async () => {
    const journal = new Journal();
    const { calls } = await pass(journal, () => ({ text: 'hi' }), {
      memory: { provider: provider([], false) },
    });
    expect(calls[0]?.tools.map((tool) => tool.name)).not.toContain('remember');
  });
});

describe('agent loop — writing a memory', () => {
  it('stores it at the actor’s own scope, with this run as its origin', async () => {
    const journal = new Journal();
    const rows: MemoryRecord[] = [];
    await pass(journal, writesAMemory, { memory: { provider: provider(rows) } });
    expect(rows).toEqual([
      {
        id: 'actor:u1/units',
        key: 'units',
        text: 'they report distances in nautical miles',
        scope: 'actor:u1',
        origin: { author: 'agent', threadId: expect.any(String), runId: RUN_ID, actorRef: 'u1' },
        updatedAt: '2026-09-10T12:00:00.000Z',
      },
    ]);
  });

  it('does not fold what it just wrote into the same turn’s system block', async () => {
    // The digest is resolved once, at a checkpoint, before the first model call. Re-resolving it
    // after a write would let the system block change between two steps of one turn — a prompt no
    // journal position covers, and one a replay could not rebuild.
    const journal = new Journal();
    const { calls } = await pass(journal, writesAMemory, {
      // Starts with a memory, so the block IS in both calls' prompts — the assertion is that its
      // CONTENTS did not change, not that a block happened to be absent.
      memory: { provider: provider([fact('shift', GLOBAL_SCOPE, 'they work nights')]) },
    });
    expect(calls[0]?.system).toContain('<memory>');
    expect(calls[1]?.system).toBe(calls[0]?.system);
    expect(calls[1]?.system).not.toContain('nautical miles');
    // It reaches the model as this call's tool RESULT instead, on the transcript.
    expect(JSON.stringify(calls[1]?.messages)).toContain('nautical miles');
  });

  it('refuses a fact over the per-fact ceiling as an ordinary tool failure, storing nothing', async () => {
    const journal = new Journal();
    const rows: MemoryRecord[] = [];
    const { names, calls } = await pass(
      journal,
      (_args, turnIndex) =>
        turnIndex === 0
          ? {
              text: 'noting',
              toolCall: { name: 'remember', input: { key: 'k', fact: 'x'.repeat(30) } },
            }
          : { text: 'done' },
      { memory: { provider: provider(rows), maxFactChars: 20 } },
    );
    expect(names).toContain(`persist:toolfail:${REMEMBER_CALL}`);
    expect(rows).toEqual([]);
    expect(JSON.stringify(calls[1]?.messages)).toContain('at most 20 characters');
  });

  it('records a provider that throws as this call’s outcome and lets the turn carry on', async () => {
    const journal = new Journal();
    const { names, text } = await pass(journal, writesAMemory, {
      memory: {
        provider: {
          list: () => [],
          forget: () => true,
          write: () => {
            throw new Error('the memory table is unreachable');
          },
        },
      },
    });
    expect(names).toContain(`persist:toolfail:${REMEMBER_CALL}`);
    expect(text).toBe('done');
  });
});

describe('agent loop — which memories entered a prompt comes out of the journal', () => {
  it('rebuilds the block from the journaled digest on a pod that would resolve a different one', async () => {
    const journal = new Journal();
    const first = await pass(journal, writesAMemory, {
      memory: { provider: provider([fact('units', GLOBAL_SCOPE, 'VERSION-ONE')]) },
    });
    expect(first.calls[0]?.system).toContain('VERSION-ONE');

    // The run suspended the moment the write was served, and resumes on a pod whose memory rows —
    // and whose scope resolution — have both moved on.
    journal.truncateAfter(`tool:${REMEMBER_CALL}`);
    const replay = await pass(journal, writesAMemory, {
      memory: {
        provider: provider([fact('units', GLOBAL_SCOPE, 'VERSION-TWO')]),
        scopes: { resolve: () => ['actor:u1'] },
      },
    });
    expect(replay.names).toEqual(first.names);
    expect(replay.calls).toHaveLength(1);
    expect(replay.calls[0]?.system).toContain('VERSION-ONE');
    expect(replay.calls[0]?.system).not.toContain('VERSION-TWO');
  });

  it('writes once across a resume, because the write is the checkpoint’s own result', async () => {
    const journal = new Journal();
    const rows: MemoryRecord[] = [];
    await pass(journal, writesAMemory, { memory: { provider: provider(rows) } });
    expect(rows).toHaveLength(1);

    journal.truncateAfter(`tool:${REMEMBER_CALL}`);
    const replayRows: MemoryRecord[] = [];
    await pass(journal, writesAMemory, { memory: { provider: provider(replayRows) } });
    // The replaying process never called the provider: the record came back from the journal.
    expect(replayRows).toEqual([]);
  });
});

/**
 * A host's index, reduced to what a test can read: word overlap over key and text, then the three
 * clauses `MemoryProvider.search` asks for — filter by scope, rank keys, return every record at a
 * ranked key plus every always-on one.
 */
function searching(rows: MemoryRecord[]): MemoryProvider & { queries: string[] } {
  const queries: string[] = [];
  return {
    queries,
    list: () => {
      throw new Error('a searching provider must not be asked to read the whole scope');
    },
    forget: () => false,
    search: ({ scopes, query, limit }) => {
      queries.push(query);
      const visible = rows.filter((row) => scopes.includes(row.scope));
      const words = query.toLowerCase().split(/\W+/).filter(Boolean);
      const scored = visible
        .map((row) => ({
          row,
          score: words.filter((word) => `${row.key} ${row.text}`.toLowerCase().includes(word))
            .length,
        }))
        .filter((candidate) => candidate.score > 0)
        .sort((a, b) => b.score - a.score);
      const keys = [...new Set(scored.map((candidate) => candidate.row.key))].slice(0, limit);
      return [
        ...keys.flatMap((key) => visible.filter((row) => row.key === key)),
        ...visible.filter((row) => row.pinned === true && !keys.includes(row.key)),
      ];
    },
  };
}

function pinned(base: MemoryRecord): MemoryRecord {
  return { ...base, pinned: true };
}

describe('agent loop — recall, once the store outgrows the block', () => {
  const crowded = [
    fact('coffee', 'actor:u1', 'they take it black'),
    fact('desk', 'actor:u1', 'they sit by the window'),
    fact('shift', 'actor:u1', 'they work nights'),
    fact('rollback-policy', 'tenant:berlin', 'roll back before 1600 local'),
  ];

  it('puts the organisation’s relevant fact in the block though the personal scope alone fills it', async () => {
    // Selecting by scope, a person's third note ends every chance their organisation's facts had:
    // `maxMemories` is spent before the widest scope is reached, and the only trace is `omitted`.
    const journal = new Journal();
    const { calls } = await pass(
      journal,
      () => ({ text: 'hi' }),
      { memory: { provider: searching(crowded), maxMemories: 2 } },
      'what is our rollback policy',
    );
    expect(calls[0]?.system).toContain('- [tenant:berlin] rollback-policy: roll back before 1600');
    expect(calls[0]?.system).not.toContain('they take it black');
  });

  it('searches with the user’s own turn text, and spends no position of its own doing it', async () => {
    const journal = new Journal();
    const index = searching(crowded);
    const { names } = await pass(
      journal,
      () => ({ text: 'hi' }),
      { memory: { provider: index, maxMemories: 2 } },
      'what is our rollback policy',
    );
    expect(index.queries).toEqual(['what is our rollback policy']);
    expect(names.filter((name) => name.startsWith('memory:'))).toEqual(['memory:digest']);
  });

  it('tells the model the block is a selection, so it does not read an absence as evidence', async () => {
    const journal = new Journal();
    const { calls } = await pass(
      journal,
      () => ({ text: 'hi' }),
      { memory: { provider: searching(crowded), maxMemories: 2 } },
      'what is our rollback policy',
    );
    expect(calls[0]?.system).toContain('not everything on file');
  });

  it('keeps an always-on fact the turn is nowhere near', async () => {
    const journal = new Journal();
    const rows = [
      ...crowded,
      pinned(fact('cache-purge', 'tenant:berlin', 'never purge the app-config cache in hours')),
    ];
    const { calls } = await pass(
      journal,
      () => ({ text: 'hi' }),
      { memory: { provider: searching(rows), maxMemories: 2 } },
      'what is our rollback policy',
    );
    expect(calls[0]?.system).toContain('never purge the app-config cache in hours');
  });

  it('rebuilds the same selection on a replay whose index has moved on', async () => {
    // The most re-derivable decision in this library: the index moves, a neighbour is written,
    // embeddings are recomputed. It happens inside `memory:digest`, so every replay reads back the
    // selection the first attempt made rather than making a new one.
    const journal = new Journal();
    const first = await pass(
      journal,
      () => ({ text: 'hi' }),
      {
        memory: {
          provider: searching([fact('rollback-policy', 'tenant:berlin', 'rollback VERSION-ONE')]),
          maxMemories: 2,
        },
      },
      'what is our rollback policy',
    );
    expect(first.calls[0]?.system).toContain('VERSION-ONE');

    journal.truncateAfter('memory:digest');
    const replay = await pass(
      journal,
      () => ({ text: 'hi' }),
      {
        memory: {
          provider: searching([fact('rollback-policy', 'tenant:berlin', 'rollback VERSION-TWO')]),
          maxMemories: 2,
        },
      },
      'what is our rollback policy',
    );
    expect(replay.calls[0]?.system).toContain('VERSION-ONE');
    expect(replay.calls[0]?.system).not.toContain('VERSION-TWO');
  });
});

describe('agent loop — whose note the model is told it is reading', () => {
  it('does not hedge a memory a person published for the organisation', async () => {
    const journal = new Journal();
    const published: MemoryRecord = {
      ...fact('rollback-policy', 'tenant:berlin', 'roll back before 1600 local'),
      origin: { author: 'human', actorRef: 'admin-1' },
    };
    const { calls } = await pass(journal, () => ({ text: 'hi' }), {
      memory: { provider: provider([published]) },
    });
    const system = calls[0]?.system ?? '';
    expect(system).toContain('- [tenant:berlin] rollback-policy: roll back before 1600 local');
    expect(system).not.toContain('prefer what the user says now');
  });

  it('still hedges what the agent concluded on its own', async () => {
    const journal = new Journal();
    const { calls } = await pass(journal, () => ({ text: 'hi' }), {
      memory: { provider: provider([fact('units', 'actor:u1', 'nautical miles')]) },
    });
    expect(calls[0]?.system).toContain('prefer what the user says now');
  });
});
