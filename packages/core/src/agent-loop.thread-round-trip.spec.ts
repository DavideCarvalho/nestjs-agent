import {
  FakeModelProvider,
  type FakeScript,
  InMemoryAgentStore,
} from '@dudousxd/nestjs-agent-testing';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  type AgentLoopDeps,
  type AgentLoopHooks,
  type AgentStreamEvent,
  DefaultRolesPolicy,
  type Passage,
  type SinkWriter,
  type StoredMessage,
  ToolRegistry,
  decodeStreamEvent,
  runAgentLoop,
} from './index.js';

/**
 * A turn is only finished when a CLIENT can read it back. Writing the store and reading the thread
 * are two halves of one contract, and each of the failures this file pins looked correct from the
 * writing half alone: the outputs were in the tool-call table, the passages were in the tool-call
 * table, the structured answer was in the tool-call table — and a reopened thread showed every one
 * of those tools as still running, because a thread reader pairs a call with its result off the
 * MESSAGE and nothing ever put them there.
 *
 * So every assertion here goes through `getThread`, and the shape asserted is the one
 * `storedMessageToUiMessage` reads: a `toolCall` with a matching `toolResult` renders its output,
 * a `toolCall` without one renders as a tool still in flight.
 */

const RUN_ID = 'run-1';
const ACTOR = { id: 'u1', roles: ['ADMIN'] };

/** The client's own pairing rule, restated: which calls on this message have an output to render. */
function settledCalls(message: StoredMessage): { name: string; output: unknown }[] {
  return (message.toolCalls ?? []).map((call) => ({
    name: call.name,
    output: message.toolResults?.find((result) => result.id === call.id)?.output,
  }));
}

function assistantMessages(messages: StoredMessage[]): StoredMessage[] {
  return messages.filter((message) => message.role === 'assistant');
}

function recordingSink(): { writer: SinkWriter; frames: () => AgentStreamEvent[] } {
  const decoder = new TextDecoder();
  const lines: string[] = [];
  return {
    writer: {
      write: (chunk) => {
        for (const line of decoder.decode(chunk).split('\n')) {
          if (line.length > 0) {
            lines.push(line);
          }
        }
      },
      end: () => {},
      fail: () => {},
    },
    frames: () =>
      lines.map(decodeStreamEvent).filter((event): event is AgentStreamEvent => event !== null),
  };
}

function registryWithLookup(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(
    { name: 'lookup', kind: 'read', description: 'look something up', inputSchema: z.object({}) },
    { execute: async () => ({ rows: [{ id: 7 }] }) },
  );
  registry.register(
    { name: 'boom', kind: 'read', description: 'always fails', inputSchema: z.object({}) },
    {
      execute: async () => {
        throw new Error('nope');
      },
    },
  );
  return registry;
}

interface RunOptions {
  script: FakeScript;
  extra?: Partial<AgentLoopDeps>;
}

async function runTurn(options: RunOptions): Promise<{
  messages: StoredMessage[];
  frames: AgentStreamEvent[];
}> {
  const store = new InMemoryAgentStore();
  const sink = recordingSink();
  const thread = await store.createThread({ actor: ACTOR });
  const deps: AgentLoopDeps = {
    model: new FakeModelProvider(options.script),
    store,
    registry: registryWithLookup(),
    rolesPolicy: new DefaultRolesPolicy(),
    modelId: 'fake-1',
    day: '2026-06-30',
    systemPrompt: 'You are a test agent.',
    ...options.extra,
  };
  const hooks: AgentLoopHooks = {
    runId: RUN_ID,
    openSink: () => sink.writer,
    awaitApproval: async () => ({ approved: true }),
    step: (_name, fn) => fn(),
  };
  await runAgentLoop(deps, { threadId: thread.id, actor: ACTOR, userText: 'hi' }, hooks);
  return { messages: (await store.getThread(thread.id))?.messages ?? [], frames: sink.frames() };
}

describe('a reopened thread — the tools a turn ran', () => {
  it('pairs each call with the output it produced', async () => {
    const script: FakeScript = (_args, turnIndex) =>
      turnIndex === 0
        ? { text: 'looking', toolCalls: [{ name: 'lookup', input: {} }] }
        : { text: 'done' };

    const { messages } = await runTurn({ script });

    const [withCalls] = assistantMessages(messages);
    expect(settledCalls(withCalls as StoredMessage)).toEqual([
      { name: 'lookup', output: { rows: [{ id: 7 }] } },
    ]);
  });

  it('pairs every call of a multi-tool turn, not just the first', async () => {
    const script: FakeScript = (_args, turnIndex) =>
      turnIndex === 0
        ? {
            text: 'looking',
            toolCalls: [
              { name: 'lookup', input: { which: 'a' } },
              { name: 'boom', input: {} },
            ],
          }
        : { text: 'done' };

    const { messages } = await runTurn({ script });

    // A tool that threw is settled too: the failure is its result, and a client that only knew
    // "no result yet" would render a crashed tool as one still running.
    const [withCalls] = assistantMessages(messages);
    expect(settledCalls(withCalls as StoredMessage)).toEqual([
      { name: 'lookup', output: { rows: [{ id: 7 }] } },
      { name: 'boom', output: null },
    ]);
    expect(withCalls?.toolResults?.[1]?.error).toBe('nope');
  });
});

describe('a reopened thread — what the answer was built from', () => {
  const passages: Passage[] = [
    { id: 'doc-1#0', text: 'refunds take five days', score: 0.9, source: 'policy.md' },
  ];
  const retriever = { retrieve: async (): Promise<Passage[]> => passages };

  it('carries inject-mode retrieval as a settled tool call shaped like a search', async () => {
    const { messages } = await runTurn({
      script: () => ({ text: 'five days' }),
      extra: { retriever },
    });

    const [answer] = assistantMessages(messages);
    // `{ passages: [{ id, text }] }` is what a client detects a provenance block by — the same
    // output an agentic `search_knowledge` call produces, which is what makes them render alike.
    expect(settledCalls(answer as StoredMessage)).toEqual([
      { name: 'retrieve', output: { passages } },
    ]);
    expect(answer?.toolCalls?.[0]?.input).toEqual({ query: 'hi' });
  });

  it('streams the retrieval live as an ordinary tool call', async () => {
    const { frames } = await runTurn({
      script: () => ({ text: 'five days' }),
      extra: { retriever },
    });

    const toolFrames = frames.filter(
      (frame) => frame.kind === 'tool-input-available' || frame.kind === 'tool-output',
    );
    expect(toolFrames).toEqual([
      {
        kind: 'tool-input-available',
        id: `retrieve-${RUN_ID}`,
        name: 'retrieve',
        input: { query: 'hi' },
        toolKind: 'read',
      },
      { kind: 'tool-output', id: `retrieve-${RUN_ID}`, output: { passages } },
    ]);
  });

  it('keeps the retrieval settled alongside the calls the model made on the same message', async () => {
    const script: FakeScript = (_args, turnIndex) =>
      turnIndex === 0
        ? { text: 'looking', toolCalls: [{ name: 'lookup', input: {} }] }
        : { text: 'done' };

    const { messages } = await runTurn({ script, extra: { retriever } });

    const [withCalls] = assistantMessages(messages);
    expect(settledCalls(withCalls as StoredMessage)).toEqual([
      { name: 'lookup', output: { rows: [{ id: 7 }] } },
      { name: 'retrieve', output: { passages } },
    ]);
  });
});

describe('a reopened thread — a structured answer', () => {
  const outputSchema = z.object({ days: z.number() });
  const model = {
    runTurn: async (args: { outputSchema?: unknown }) => ({
      text: args.outputSchema !== undefined ? '{"days":5}' : 'five days',
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 1 },
    }),
  };

  it('carries the validated object as a settled tool call', async () => {
    const { messages } = await runTurn({
      script: () => ({ text: 'unused' }),
      extra: { model, outputSchema },
    });

    const [answer] = assistantMessages(messages);
    expect(settledCalls(answer as StoredMessage)).toEqual([
      { name: 'structured_output', output: { days: 5 } },
    ]);
  });

  it('streams it live as an ordinary tool call', async () => {
    const { frames } = await runTurn({
      script: () => ({ text: 'unused' }),
      extra: { model, outputSchema },
    });

    expect(
      frames.filter(
        (frame) => frame.kind === 'tool-input-available' || frame.kind === 'tool-output',
      ),
    ).toEqual([
      {
        kind: 'tool-input-available',
        id: `structured-${RUN_ID}`,
        name: 'structured_output',
        input: {},
        toolKind: 'read',
      },
      { kind: 'tool-output', id: `structured-${RUN_ID}`, output: { days: 5 } },
    ]);
  });
});

describe('a reopened thread — a question the agent asked', () => {
  it('settles the intake form with the answers the user sent back', async () => {
    const { messages } = await runTurn({
      script: () => ({ text: 'thanks' }),
      extra: {
        intake: {
          questions: [
            {
              id: 'scope',
              prompt: 'How wide?',
              options: [
                { value: 'team', label: 'This team' },
                { value: 'org', label: 'The whole org' },
              ],
              defaults: ['team'],
            },
          ],
        },
      },
    });

    const [form] = assistantMessages(messages);
    const [settled] = settledCalls(form as StoredMessage);
    expect(settled?.name).toBe('ask');
    expect(settled?.output).toMatchObject({ answers: { scope: ['team'] } });
  });
});
