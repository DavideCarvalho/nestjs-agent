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
  type StoredMessage,
  type ThreadTurnPage,
  type ThreadTurnQuery,
  type ThreadTurnReader,
  ToolRegistry,
  runAgentLoop,
  windowHistory,
} from './index.js';

const RUN_ID = 'run-1';
const ACTOR = { id: 'u1', roles: ['ADMIN'] };

/**
 * The durable engine's replay contract, reduced to what this file needs: checkpoints are positional
 * and their outputs round-trip through JSON like a real journal's, which is what makes the recorded
 * payload here the same string a MySQL JSON column would hold.
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
      return (existing.output === undefined ? undefined : JSON.parse(existing.output)) as T;
    }
    const output = await produce();
    const serialized = output === undefined ? undefined : JSON.stringify(output);
    this.entries[position] = { name, output: serialized };
    return (serialized === undefined ? undefined : JSON.parse(serialized)) as T;
  }
}

/**
 * The columns a SQL adapter's window read projects to — `usage`, `followUps` and `runId` stay in the
 * table. Mirrored here so the double is faithful about what it does NOT return, not just about how
 * many rows it returns.
 */
function projected(message: StoredMessage): StoredMessage {
  const { usage: _usage, followUps: _followUps, runId: _runId, ...turnColumns } = message;
  return turnColumns;
}

/**
 * A store that offers the window read, standing in for both SQL adapters: newest `messageLimit`
 * rows, oldest-first, projected — and `hasAssistantMessage` answered over the WHOLE thread, which is
 * the part a page-derived implementation would get wrong. Records every query it was handed.
 */
class WindowingStore extends InMemoryAgentStore implements ThreadTurnReader {
  readonly queries: ThreadTurnQuery[] = [];

  async loadThreadForTurn(query: ThreadTurnQuery): Promise<ThreadTurnPage | null> {
    this.queries.push(query);
    const thread = await this.getThread(query.threadId);
    if (thread === null) {
      return null;
    }
    const all = thread.messages;
    const limit = query.messageLimit;
    const window =
      limit === undefined ? all : limit <= 0 ? [] : all.slice(Math.max(0, all.length - limit));
    return {
      title: thread.title,
      defaultAgent: thread.defaultAgent ?? null,
      hasAssistantMessage: all.some((message) => message.role === 'assistant'),
      messages: window.map(projected),
    };
  }
}

/** A thread `turns` exchanges deep, each assistant message carrying a fat tool result. */
async function seed(store: InMemoryAgentStore, turns: number, outputBytes: number) {
  const thread = await store.createThread({ actor: ACTOR });
  for (let index = 0; index < turns; index += 1) {
    await store.appendMessage({ threadId: thread.id, role: 'user', content: `question ${index}` });
    await store.appendMessage({
      threadId: thread.id,
      role: 'assistant',
      content: `answer ${index}`,
      runId: `old-run-${index}`,
      usage: { inputTokens: 10, outputTokens: 20 },
      followUps: ['and then?'],
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

  async runTurn(args: ModelTurnArgs): Promise<ModelTurnResult> {
    this.seen.push({ ...args, messages: args.messages.map((message) => ({ ...message })) });
    await args.sink.write(new TextEncoder().encode('answered'));
    return { text: 'answered', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
  }
}

interface PassOptions {
  journal: Journal;
  store: InMemoryAgentStore;
  threadId: string;
  historyPolicy?: HistoryPolicy;
}

async function pass(options: PassOptions): Promise<Answering> {
  const sink = new InMemoryTokenStreamSink();
  const model = new Answering();
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
  };
  options.journal.rewind();
  await runAgentLoop(deps, { threadId: options.threadId, actor: ACTOR, userText: 'hi' }, hooks);
  return model;
}

function contents(messages: ModelMessage[]): string[] {
  return messages.map((message) => message.content);
}

describe('agent loop — reading the thread through the store’s window', () => {
  it('asks for the policy’s row ceiling and sends exactly that window', async () => {
    const store = new WindowingStore();
    const thread = await seed(store, 20, 64);
    const journal = new Journal();

    const model = await pass({
      journal,
      store,
      threadId: thread.id,
      historyPolicy: windowHistory({ maxMessages: 4 }),
    });

    expect(store.queries).toEqual([{ threadId: thread.id, messageLimit: 4 }]);
    expect(contents(model.seen[0]?.messages ?? [])).toEqual([
      'answer 18',
      'question 19',
      'answer 19',
      'hi',
    ]);
  });

  it('journals the payload the full read journals, byte for byte', async () => {
    // Same thread contents on both sides, so the ONLY difference is which read the store offered.
    const windowing = new WindowingStore();
    const windowingThread = await seed(windowing, 20, 512);
    const full = new InMemoryAgentStore();
    const fullThread = await seed(full, 20, 512);

    const policy = () => windowHistory({ maxMessages: 4 });
    const windowed = new Journal();
    await pass({
      journal: windowed,
      store: windowing,
      threadId: windowingThread.id,
      historyPolicy: policy(),
    });
    const whole = new Journal();
    await pass({ journal: whole, store: full, threadId: fullThread.id, historyPolicy: policy() });

    // The checkpoint is a wire contract with every run already in flight: a resume reads this string
    // back rather than calling the store at all, so the two reads have to be indistinguishable here.
    expect(windowed.recorded('load:thread')).toBe(whole.recorded('load:thread'));
    expect(windowed.names()).toEqual(whole.names());
    // And the shape itself is pinned, not just the two paths' agreement with each other: a field
    // added to what `load:thread` records changes the payload for BOTH, so only naming the keys
    // catches it.
    expect(Object.keys(JSON.parse(windowed.recorded('load:thread'))).sort()).toEqual([
      'dropped',
      'hasAssistantMessage',
      'messages',
      'title',
    ]);
  });

  it('falls back to the full read for a store that offers no window', async () => {
    const store = new InMemoryAgentStore();
    const thread = await seed(store, 3, 64);
    const journal = new Journal();

    const model = await pass({
      journal,
      store,
      threadId: thread.id,
      historyPolicy: windowHistory({ maxMessages: 2 }),
    });

    expect(contents(model.seen[0]?.messages ?? [])).toEqual(['answer 2', 'hi']);
    expect(journal.names()).toContain('load:thread');
  });

  it('asks for no row limit where the policy summarizes — the fold reads what the window dropped', async () => {
    const store = new WindowingStore();
    const thread = await seed(store, 6, 64);
    const journal = new Journal();

    const model = await pass({
      journal,
      store,
      threadId: thread.id,
      historyPolicy: windowHistory({
        maxMessages: 2,
        summarize: async (messages) => ({ text: `folded ${messages.length}` }),
      }),
    });

    // A read bounded to what `select` KEEPS drops nothing, so the summary would stand in for no
    // messages at all — silently, in a prompt that is missing them.
    expect(store.queries).toEqual([{ threadId: thread.id }]);
    expect(model.seen[0]?.messages[0]?.content).toContain('folded 11');
  });

  it('asks for no row limit where the ceiling is only a token budget', async () => {
    const store = new WindowingStore();
    const thread = await seed(store, 6, 64);

    await pass({
      journal: new Journal(),
      store,
      threadId: thread.id,
      historyPolicy: windowHistory({ maxTokens: 200 }),
    });

    // No row count follows from a token budget: one message can be four tokens or forty thousand.
    expect(store.queries).toEqual([{ threadId: thread.id }]);
  });

  it('asks for no row limit where no ceiling is configured at all', async () => {
    const store = new WindowingStore();
    const thread = await seed(store, 3, 64);

    await pass({ journal: new Journal(), store, threadId: thread.id });

    expect(store.queries).toEqual([{ threadId: thread.id }]);
  });

  it('takes “has this been answered” from the thread, not from the window', async () => {
    const store = new WindowingStore();
    const thread = await seed(store, 1, 64);
    // Two later questions nobody answered, so the newest 2 rows hold no assistant message at all —
    // while the conversation plainly has been answered.
    await store.appendMessage({ threadId: thread.id, role: 'user', content: 'still there?' });
    const journal = new Journal();

    await pass({
      journal,
      store,
      threadId: thread.id,
      historyPolicy: windowHistory({ maxMessages: 2 }),
    });

    const payload = JSON.parse(journal.recorded('load:thread')) as {
      messages: ModelMessage[];
      hasAssistantMessage: boolean;
    };
    expect(payload.messages.some((message) => message.role === 'assistant')).toBe(false);
    // Read off the page instead, a `thread-start` intake would re-introduce itself every turn.
    expect(payload.hasAssistantMessage).toBe(true);
  });

  it('reads a fraction of the bytes the full read materializes', async () => {
    const store = new WindowingStore();
    // The measured case: a 50-turn thread whose turns each ran a 50 KB tool.
    const thread = await seed(store, 50, 50 * 1024);
    const transcript = await store.getThread(thread.id);

    const whole = JSON.stringify(transcript).length;
    const window = JSON.stringify(
      await store.loadThreadForTurn({ threadId: thread.id, messageLimit: 4 }),
    ).length;
    const toolOutputs = JSON.stringify(
      (transcript?.messages ?? []).map((message) => message.toolResults ?? null),
    ).length;

    // ~2.6 MB, of which nearly all is tool output the prompt was never going to carry — paid on
    // every turn, and again on every replay, to send a window bounded to four messages.
    expect(whole).toBeGreaterThan(2_000_000);
    expect(toolOutputs / whole).toBeGreaterThan(0.95);
    // ~103 KB: the window itself, which is the prompt the model is being sent anyway.
    expect(window).toBeLessThan(whole / 20);
  });
});
