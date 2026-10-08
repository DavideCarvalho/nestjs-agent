import { randomUUID } from 'node:crypto';
import {
  type AgentStore,
  DefaultRolesPolicy,
  type ModelMessage,
  type ModelProvider,
  type ModelTurnArgs,
  type ModelTurnResult,
  type SinkWriter,
  ToolRegistry,
  runAgentLoop,
} from '@dudousxd/nestjs-agent-core';

/** A store under test. */
export interface BlankAssistantHistoryContractSubject {
  store: AgentStore;
}

/** One behaviour the agent loop owes on top of an {@link AgentStore}. `run` throws on a mismatch. */
export interface BlankAssistantHistoryContractCase {
  name: string;
  run: (subject: BlankAssistantHistoryContractSubject) => Promise<void>;
}

function check(condition: boolean, message: string, actual?: unknown): void {
  if (!condition) {
    throw new Error(actual === undefined ? message : `${message} (got ${JSON.stringify(actual)})`);
  }
}

const ACTOR = { id: 'blank-assistant-actor', roles: ['ADMIN'] };
const discard: SinkWriter = { write: () => {}, end: () => {}, fail: () => {} };

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
    return { ...step, usage: { inputTokens: 1, outputTokens: 1 } };
  }
}

function registry(): ToolRegistry {
  const tools = new ToolRegistry();
  tools.register(
    {
      name: 'renderResult',
      kind: 'read',
      description: 'draw a card',
      inputSchema: {
        '~standard': { version: 1, vendor: 'test', validate: (value) => ({ value }) },
      },
    },
    { execute: async () => ({ rendered: true }) },
  );
  return tools;
}

async function turn(store: AgentStore, model: ModelProvider, threadId: string, userText: string) {
  await runAgentLoop(
    {
      model,
      store,
      registry: registry(),
      rolesPolicy: new DefaultRolesPolicy(),
      modelId: 'fake-1',
      day: '2026-10-08',
      systemPrompt: 'You are a test agent.',
    },
    { threadId, actor: ACTOR, userText },
    {
      runId: `run-${randomUUID()}`,
      openSink: () => discard,
      awaitApproval: async () => ({ approved: true }),
      step: (_name, fn) => fn(),
    },
  );
}

/** Assistant messages a provider refuses: blank text and nothing else. */
function blankAssistants(messages: { role: string; content: string }[]): number {
  return messages.filter(
    (message) =>
      message.role === 'assistant' &&
      message.content.trim().length === 0 &&
      ((message as ModelMessage).toolCalls?.length ?? 0) === 0 &&
      ((message as ModelMessage).toolResults?.length ?? 0) === 0,
  ).length;
}

/**
 * A model can end a step with no text (Claude does, right after a tool whose result IS the answer),
 * and Anthropic and Bedrock refuse a request replaying an empty assistant message — so one on a
 * thread fails every later turn. What the loop owes through any store: it never stores one, and a
 * thread that already holds one (written by an older version) still reaches the model without it.
 * Run it against a real database, where the read path is the store's own:
 *
 * ```ts
 * for (const contractCase of BLANK_ASSISTANT_HISTORY_CONTRACT) {
 *   it(contractCase.name, async () => contractCase.run({ store }));
 * }
 * ```
 */
export const BLANK_ASSISTANT_HISTORY_CONTRACT: readonly BlankAssistantHistoryContractCase[] = [
  {
    name: 'a step that ends with no text after a tool is not stored, and the next turn replays none',
    async run({ store }) {
      const thread = await store.createThread({ actor: ACTOR });
      const callId = `render-${randomUUID()}`;
      const model = new ScriptedModel([
        { text: '', toolCalls: [{ id: callId, name: 'renderResult', input: {} }] },
        { text: '', toolCalls: [] },
        { text: 'second answer', toolCalls: [] },
      ]);

      await turn(store, model, thread.id, 'show me the users');
      await turn(store, model, thread.id, 'and now?');

      const stored = (await store.getThread(thread.id))?.messages ?? [];
      check(blankAssistants(stored) === 0, 'no blank assistant message is stored', stored);
      const roles = stored.map((message) => message.role);
      check(
        JSON.stringify(roles) === JSON.stringify(['user', 'assistant', 'user', 'assistant']),
        'the thread holds the tool exchange and the second answer',
        roles,
      );
      check(
        stored[1]?.toolCalls?.[0]?.id === callId && stored[1]?.toolResults?.[0]?.id === callId,
        'the tool-call-only message keeps its call and result',
        stored[1],
      );
      const prompt = model.prompts[2] ?? [];
      check(blankAssistants(prompt) === 0, 'the second turn sends no blank assistant', prompt);
      check(
        prompt.some((message) => message.toolCalls?.[0]?.id === callId),
        'the second turn still sends the tool exchange',
        prompt,
      );
    },
  },
  {
    name: 'a thread already holding empty assistant messages heals on its next turn',
    async run({ store }) {
      const thread = await store.createThread({ actor: ACTOR });
      const callId = `render-${randomUUID()}`;
      await store.appendMessage({
        threadId: thread.id,
        role: 'user',
        content: 'show me the users',
      });
      await store.appendMessage({
        threadId: thread.id,
        role: 'assistant',
        content: '',
        toolCalls: [{ id: callId, name: 'renderResult', input: {}, kind: 'read' }],
        toolResults: [{ id: callId, name: 'renderResult', output: { rendered: true } }],
      });
      await store.appendMessage({ threadId: thread.id, role: 'assistant', content: '' });
      await store.appendMessage({ threadId: thread.id, role: 'user', content: 'still there?' });
      await store.appendMessage({ threadId: thread.id, role: 'assistant', content: ' \n ' });
      const model = new ScriptedModel([{ text: 'healed', toolCalls: [] }]);

      await turn(store, model, thread.id, 'hello?');

      const prompt = model.prompts[0] ?? [];
      check(blankAssistants(prompt) === 0, 'no blank assistant reaches the model', prompt);
      const shape = prompt.map((message) => message.role);
      check(
        JSON.stringify(shape) === JSON.stringify(['user', 'assistant', 'user', 'user']),
        'everything else of the thread reaches the model, in order',
        shape,
      );
      check(
        prompt[1]?.toolCalls?.[0]?.id === callId,
        'the tool-call-only message is kept',
        prompt[1],
      );
    },
  },
];
