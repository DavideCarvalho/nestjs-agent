import { InMemoryAgentStore, InMemoryTokenStreamSink } from '@dudousxd/nestjs-agent-testing';
import { describe, expect, it } from 'vitest';
import {
  type AgentLoopDeps,
  type AgentLoopHooks,
  DefaultRolesPolicy,
  type HistoryPolicy,
  type ModelMessage,
  type ModelProvider,
  type ModelTurnArgs,
  type ModelTurnResult,
  ToolRegistry,
  runAgentLoop,
  windowHistory,
} from './index.js';

const RUN_ID = 'run-1';
const ACTOR = { id: 'u1', roles: ['ADMIN'] };

/**
 * The durable engine's replay contract, reduced to what this file needs: checkpoints are positional,
 * a name that disagrees with the one recorded at that position is a NonDeterminismError, and outputs
 * round-trip through JSON like a real journal's — which is the point here, since what this file
 * measures is how many bytes an entry costs. `patched` is the version gate: it consumes a position
 * for a run that first arrives at it and gives it back to one whose history already holds a real
 * step there.
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

  /** The serialized payload recorded at `name` — what a MySQL JSON column would hold. */
  recorded(name: string): string {
    const entry = this.entries.find((candidate) => candidate.name === name);
    if (entry?.output === undefined) {
      throw new Error(`no output recorded for "${name}"`);
    }
    return entry.output;
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

  async patched(id: string): Promise<boolean> {
    const marker = `patch:${id}`;
    const position = this.seq;
    this.seq += 1;
    const existing = this.entries[position];
    if (existing !== undefined) {
      if (existing.name === marker) {
        return true;
      }
      this.seq -= 1;
      return false;
    }
    this.entries[position] = { name: marker, output: 'true' };
    return true;
  }
}

/** A thread `turns` exchanges deep, each assistant message carrying a fat tool result. */
async function seed(store: InMemoryAgentStore, turns: number, outputBytes: number) {
  const thread = await store.createThread({ actor: ACTOR });
  for (let index = 0; index < turns; index += 1) {
    await store.appendMessage({
      threadId: thread.id,
      role: 'user',
      content: `question ${index}`,
    });
    await store.appendMessage({
      threadId: thread.id,
      role: 'assistant',
      content: `answer ${index}`,
      toolCalls: [{ id: `old-${index}`, name: 'lookup', input: {}, kind: 'read' }],
      toolResults: [
        { id: `old-${index}`, name: 'lookup', output: { rows: 'r'.repeat(outputBytes) } },
      ],
    });
  }
  return thread;
}

/** Answers once, with no tool calls, recording every prompt it was given. */
class Answering implements ModelProvider {
  readonly seen: ModelTurnArgs[] = [];
  constructor(private readonly onTurn?: () => void) {}

  async runTurn(args: ModelTurnArgs): Promise<ModelTurnResult> {
    this.onTurn?.();
    // Snapshot: the loop keeps pushing onto the very array it handed the model.
    this.seen.push({ ...args, messages: args.messages.map((message) => ({ ...message })) });
    await args.sink.write(new TextEncoder().encode('answered'));
    return { text: 'answered', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
  }
}

interface PassOptions {
  journal: Journal;
  store: InMemoryAgentStore;
  threadId: string;
  model?: ModelProvider;
  historyPolicy?: HistoryPolicy;
  /** Omit to leave the version gate unwired, as a runner that records no positions does. */
  patched?: (id: string) => Promise<boolean>;
}

async function pass(options: PassOptions): Promise<ModelProvider & { seen: ModelTurnArgs[] }> {
  const sink = new InMemoryTokenStreamSink();
  const model = (options.model as Answering | undefined) ?? new Answering();
  const deps: AgentLoopDeps = {
    model,
    store: options.store,
    registry: new ToolRegistry(),
    rolesPolicy: new DefaultRolesPolicy(),
    modelId: 'fake-1',
    day: '2026-06-30',
    systemPrompt: 'You are a test agent.',
    ...(options.historyPolicy !== undefined ? { historyPolicy: options.historyPolicy } : {}),
  };
  const hooks: AgentLoopHooks = {
    runId: RUN_ID,
    openSink: () => sink.open(RUN_ID),
    awaitApproval: async () => ({ approved: true }),
    step: (name, fn) => options.journal.at(name, () => fn()),
    ...(options.patched !== undefined ? { patched: options.patched } : {}),
  };
  options.journal.rewind();
  await runAgentLoop(
    deps,
    { threadId: options.threadId, actor: ACTOR, userText: 'hi' },
    hooks,
  ).catch((error: unknown) => {
    if (!(error instanceof Error) || error.message !== 'suspended') {
      throw error;
    }
  });
  return model;
}

function contents(messages: ModelMessage[]): string[] {
  return messages.map((message) => message.content);
}

describe('agent loop — what `load:thread` puts in the journal', () => {
  it('records the messages the turn sends, not the thread the store returned', async () => {
    const store = new InMemoryAgentStore();
    const thread = await seed(store, 20, 8192);
    const journal = new Journal();
    const wholeThread = JSON.stringify(await store.getThread(thread.id)).length;

    await pass({
      journal,
      store,
      threadId: thread.id,
      historyPolicy: windowHistory({ maxMessages: 4 }),
    });

    const payload = JSON.parse(journal.recorded('load:thread')) as { messages: ModelMessage[] };
    expect(contents(payload.messages)).toEqual(['answer 18', 'question 19', 'answer 19', 'hi']);
    // The measurement. `hooks.step` checkpoints its OUTPUT, so whatever this holds is written to the
    // journal, re-read on every replay, and re-parsed by every process that resumes the run. A
    // ceiling the model's prompt respects and the journal does not is a ceiling on half the cost.
    const recorded = journal.recorded('load:thread').length;
    expect(recorded).toBeLessThan(wholeThread / 5);
    // And what is left is the window itself: the two kept assistant messages carry 8 KB of tool
    // result each, which is the prompt the model is being sent anyway.
    expect(recorded).toBeLessThan(JSON.stringify(payload.messages).length + 200);
  });

  it('leaves the store row’s own fields out even when the ceiling drops nothing', async () => {
    const store = new InMemoryAgentStore();
    const thread = await seed(store, 2, 64);
    const journal = new Journal();

    await pass({ journal, store, threadId: thread.id });

    const recorded = journal.recorded('load:thread');
    expect(contents((JSON.parse(recorded) as { messages: ModelMessage[] }).messages)).toEqual([
      'question 0',
      'answer 0',
      'question 1',
      'answer 1',
      'hi',
    ]);
    // Message ids, timestamps and per-message usage are the store's bookkeeping. The turn never
    // reads them, so the journal has no reason to carry them into every replay.
    expect(recorded).not.toContain('createdAt');
    expect(
      (JSON.parse(recorded) as { messages: object[] }).messages.every(
        (message) => !('id' in message),
      ),
    ).toBe(true);
  });

  it('records what the ceiling dropped only where a summarizer will be handed it', async () => {
    const windowedStore = new InMemoryAgentStore();
    const windowedThread = await seed(windowedStore, 6, 64);
    const windowed = new Journal();
    await pass({
      journal: windowed,
      store: windowedStore,
      threadId: windowedThread.id,
      historyPolicy: windowHistory({ maxMessages: 2 }),
    });
    const dropped = (JSON.parse(windowed.recorded('load:thread')) as { dropped: ModelMessage[] })
      .dropped;
    // Nothing is going to read them, so they are not written down.
    expect(dropped).toEqual([]);
    expect(windowed.names()).not.toContain('history:summarize');

    const foldingStore = new InMemoryAgentStore();
    const foldingThread = await seed(foldingStore, 6, 64);
    const summarizing = new Journal();
    const model = await pass({
      journal: summarizing,
      store: foldingStore,
      threadId: foldingThread.id,
      historyPolicy: windowHistory({
        maxMessages: 2,
        summarize: async (messages) => ({ text: `folded ${messages.length}` }),
      }),
    });
    const carried = (JSON.parse(summarizing.recorded('load:thread')) as { dropped: ModelMessage[] })
      .dropped;
    // With a summarizer they ARE read — by a checkpoint that can run in a later process than the
    // one that loaded them, so the journal is the only place they can come from.
    expect(contents(carried)).toEqual([
      'question 0',
      'answer 0',
      'question 1',
      'answer 1',
      'question 2',
      'answer 2',
      'question 3',
      'answer 3',
      'question 4',
      'answer 4',
      'question 5',
    ]);
    const names = summarizing.names();
    expect(names.indexOf('history:summarize')).toBe(names.indexOf('load:thread') + 1);
    expect(model.seen[0]?.messages[0]?.content).toContain('folded 11');
  });

  it('spends no position on the guard for a runner that records none', async () => {
    const store = new InMemoryAgentStore();
    const thread = await seed(store, 1, 64);
    const journal = new Journal();

    await pass({ journal, store, threadId: thread.id });

    expect(journal.names().some((name) => name.startsWith('patch:'))).toBe(false);
    expect(journal.names().slice(0, 3)).toEqual(['persist:user', 'load:thread', 'run:started-at']);
  });
});

describe('agent loop — a run recorded before the selection moved into the checkpoint', () => {
  /** The window and summarizer the run below was configured with, on both processes. */
  const policy = windowHistory({
    maxMessages: 2,
    summarize: async (messages) => ({ text: `folded ${messages.length}` }),
  });

  it('finishes on the whole-thread payload its history holds', async () => {
    const store = new InMemoryAgentStore();
    const thread = await seed(store, 6, 64);
    const journal = new Journal();

    // Process 1 runs the release that journaled the whole `ThreadDetail`. `patched` answering false
    // is how the durable runtime says "this run started before the shape changed" — and it is the
    // only answer a run whose history has a real step where the marker would sit can get.
    const suspending = new Answering(() => {
      throw new Error('suspended');
    });
    await pass({
      journal,
      store,
      threadId: thread.id,
      model: suspending,
      historyPolicy: policy,
      patched: async () => false,
    });
    const recorded = journal.recorded('load:thread');
    // Byte-for-byte the previous release's payload: the store's rows, ids and timestamps and all.
    expect(recorded).toBe(JSON.stringify(await store.getThread(thread.id)));
    expect(journal.names()).toEqual([
      'persist:user',
      'load:thread',
      'history:summarize',
      'run:started-at',
      'persist:run:start',
      'stream:step-start:0',
    ]);

    // Process 2 is the new release resuming the same run, with the REAL gate. Reading the recorded
    // payload as the new shape would send the model the whole thread with no summary in front of
    // it, and then ask for `history:summarize` at a position that has already been spent.
    const model = await pass({
      journal,
      store,
      threadId: thread.id,
      historyPolicy: policy,
      patched: (id) => journal.patched(id),
    });

    expect(journal.names()).not.toContain('patch:agent:selected-history');
    const sent = model.seen[0]?.messages ?? [];
    expect(sent[0]?.role).toBe('system');
    expect(sent[0]?.content).toContain('folded 11');
    expect(contents(sent).slice(1)).toEqual(['answer 5', 'hi']);
  });

  it('takes the new shape for a run that arrives at the guard first', async () => {
    const store = new InMemoryAgentStore();
    const thread = await seed(store, 6, 64);
    const journal = new Journal();

    const model = await pass({
      journal,
      store,
      threadId: thread.id,
      historyPolicy: policy,
      patched: (id) => journal.patched(id),
    });

    expect(journal.names()[1]).toBe('patch:agent:selected-history');
    const payload = JSON.parse(journal.recorded('load:thread')) as { messages: ModelMessage[] };
    expect(contents(payload.messages)).toEqual(['answer 5', 'hi']);
    // The prompt is the same one the old shape produced — only the journal behind it changed.
    const sent = model.seen[0]?.messages ?? [];
    expect(sent[0]?.content).toContain('folded 11');
    expect(contents(sent).slice(1)).toEqual(['answer 5', 'hi']);
  });
});
