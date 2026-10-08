import { InMemoryAgentStore } from '@dudousxd/nestjs-agent-testing';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  type AgentLoopDeps,
  type AgentLoopHooks,
  type AgentStore,
  DefaultRolesPolicy,
  type ModelMessage,
  type ModelProvider,
  type ModelTurnArgs,
  type ModelTurnResult,
  type SinkWriter,
  ToolRegistry,
  runAgentLoop,
  windowHistory,
} from './index.js';

/**
 * A model can end a step with no text at all — Claude does it right after a tool whose result IS
 * the answer (`renderResult` drawing a card). Anthropic and Bedrock refuse a request that replays
 * an empty assistant message, so one stored on a thread fails every later turn on it. These pin
 * both halves: the loop never writes one, and a thread that already holds one still answers.
 */

const ACTOR = { id: 'u1', roles: ['ADMIN'] };
const USAGE = { inputTokens: 1, outputTokens: 1 };

type Step = Pick<ModelTurnResult, 'text' | 'toolCalls'>;

/** Plays `steps` in order, one per model call, and snapshots every prompt it was handed. */
class ScriptedModel implements ModelProvider {
  readonly prompts: ModelMessage[][] = [];
  private next = 0;

  constructor(private readonly steps: Step[]) {}

  async runTurn(args: ModelTurnArgs): Promise<ModelTurnResult> {
    this.prompts.push(args.messages.map((message) => ({ ...message })));
    const step = this.steps[this.next] ?? { text: 'fallback', toolCalls: [] };
    this.next += 1;
    return { ...step, usage: USAGE };
  }
}

const discard: SinkWriter = { write: () => {}, end: () => {}, fail: () => {} };

function registry(): ToolRegistry {
  const tools = new ToolRegistry();
  tools.register(
    { name: 'renderResult', kind: 'read', description: 'draw a card', inputSchema: z.object({}) },
    { execute: async () => ({ rendered: true }) },
  );
  return tools;
}

async function turn(
  store: AgentStore,
  model: ModelProvider,
  threadId: string,
  userText: string,
  runId: string,
  extra: Partial<AgentLoopDeps> = {},
): Promise<string> {
  const deps: AgentLoopDeps = {
    model,
    store,
    registry: registry(),
    rolesPolicy: new DefaultRolesPolicy(),
    modelId: 'fake-1',
    day: '2026-10-08',
    systemPrompt: 'You are a test agent.',
    ...extra,
  };
  const hooks: AgentLoopHooks = {
    runId,
    openSink: () => discard,
    awaitApproval: async () => ({ approved: true }),
    step: (_name, fn) => fn(),
  };
  const result = await runAgentLoop(deps, { threadId, actor: ACTOR, userText }, hooks);
  return result.text;
}

/** An assistant message a provider would refuse: nothing but blank text. */
function blankAssistants(messages: ModelMessage[]): ModelMessage[] {
  return messages.filter(
    (message) =>
      message.role === 'assistant' &&
      message.content.trim().length === 0 &&
      (message.toolCalls?.length ?? 0) === 0 &&
      (message.toolResults?.length ?? 0) === 0,
  );
}

describe('agent loop — a step that ends with no text', () => {
  it('is not persisted, and the next turn sends no empty assistant message', async () => {
    const store = new InMemoryAgentStore();
    const thread = await store.createThread({ actor: ACTOR });
    const model = new ScriptedModel([
      // Turn 1: call the tool with no text, then stop with no text either.
      { text: '', toolCalls: [{ id: 'call-render', name: 'renderResult', input: {} }] },
      { text: '', toolCalls: [] },
      // Turn 2.
      { text: 'second answer', toolCalls: [] },
    ]);

    await turn(store, model, thread.id, 'show me the users', 'run-1');
    await turn(store, model, thread.id, 'and now?', 'run-2');

    const stored = (await store.getThread(thread.id))?.messages ?? [];
    // The tool exchange stays — as a tool-call-only assistant message, which every provider takes.
    expect(stored.map((message) => [message.role, message.content])).toEqual([
      ['user', 'show me the users'],
      ['assistant', ''],
      ['user', 'and now?'],
      ['assistant', 'second answer'],
    ]);
    expect(stored[1]?.toolCalls?.map((call) => call.name)).toEqual(['renderResult']);
    expect(stored[1]?.toolResults?.map((result) => result.output)).toEqual([{ rendered: true }]);

    const secondTurnPrompt = model.prompts[2] ?? [];
    expect(blankAssistants(secondTurnPrompt)).toEqual([]);
    expect(secondTurnPrompt.map((message) => message.role)).toEqual(['user', 'assistant', 'user']);
    expect(secondTurnPrompt[1]?.toolCalls?.map((call) => call.name)).toEqual(['renderResult']);
  });

  it('is not persisted when its text is whitespace only', async () => {
    const store = new InMemoryAgentStore();
    const thread = await store.createThread({ actor: ACTOR });
    const model = new ScriptedModel([{ text: ' \n\t', toolCalls: [] }]);

    await turn(store, model, thread.id, 'hi', 'run-1');

    const stored = (await store.getThread(thread.id))?.messages ?? [];
    expect(stored.map((message) => message.role)).toEqual(['user']);
  });

  it('leaves the follow-up prompt without an empty assistant message, and keeps the suggestions', async () => {
    const store = new InMemoryAgentStore();
    const thread = await store.createThread({ actor: ACTOR });
    const model = new ScriptedModel([
      { text: '', toolCalls: [] },
      { text: '["what next?"]', toolCalls: [] },
    ]);

    await turn(store, model, thread.id, 'hi', 'run-1', { followUpsCount: 1 });

    expect(blankAssistants(model.prompts[1] ?? [])).toEqual([]);
    // The suggestions have to live on a message, so this one is kept — and the read side keeps
    // its blank text out of the next prompt.
    const stored = (await store.getThread(thread.id))?.messages ?? [];
    expect(stored[1]?.followUps).toEqual(['what next?']);
  });
});

describe('agent loop — a thread that already holds an empty assistant message', () => {
  async function poisoned(store: AgentStore): Promise<string> {
    const thread = await store.createThread({ actor: ACTOR });
    await store.appendMessage({ threadId: thread.id, role: 'user', content: 'show me the users' });
    await store.appendMessage({
      threadId: thread.id,
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'old-render', name: 'renderResult', input: {}, kind: 'read' }],
      toolResults: [{ id: 'old-render', name: 'renderResult', output: { rendered: true } }],
    });
    // What a library before this fix wrote for the blank final step.
    await store.appendMessage({ threadId: thread.id, role: 'assistant', content: '' });
    await store.appendMessage({ threadId: thread.id, role: 'user', content: 'still there?' });
    await store.appendMessage({ threadId: thread.id, role: 'assistant', content: ' \n ' });
    return thread.id;
  }

  it('heals on the next turn: the blank messages never reach the model', async () => {
    const store = new InMemoryAgentStore();
    const threadId = await poisoned(store);
    const model = new ScriptedModel([{ text: 'healed', toolCalls: [] }]);

    expect(await turn(store, model, threadId, 'hello?', 'run-1')).toBe('healed');

    const prompt = model.prompts[0] ?? [];
    expect(blankAssistants(prompt)).toEqual([]);
    expect(prompt.map((message) => [message.role, message.content])).toEqual([
      ['user', 'show me the users'],
      ['assistant', ''],
      ['user', 'still there?'],
      ['user', 'hello?'],
    ]);
    expect(prompt[1]?.toolCalls?.map((call) => call.name)).toEqual(['renderResult']);
  });

  it('heals under a history window too', async () => {
    const store = new InMemoryAgentStore();
    const threadId = await poisoned(store);
    const model = new ScriptedModel([{ text: 'healed', toolCalls: [] }]);

    await turn(store, model, threadId, 'hello?', 'run-1', {
      historyPolicy: windowHistory({ maxMessages: 10 }),
    });

    expect(blankAssistants(model.prompts[0] ?? [])).toEqual([]);
  });
});
