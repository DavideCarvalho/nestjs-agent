import type { ThreadDetail } from '@dudousxd/nestjs-agent-core';
import { InMemoryAgentStore, InMemoryGovernanceQueries } from '@dudousxd/nestjs-agent-testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GovernanceRunSampleSource } from './governance-sample-source.js';

/** Counts transcript reads, to prove a batch does not re-read one thread once per turn it holds. */
class CountingStore extends InMemoryAgentStore {
  threadReads = 0;
  override async getThread(threadId: string): Promise<ThreadDetail | null> {
    this.threadReads += 1;
    return super.getThread(threadId);
  }
}

/**
 * Writes in the order the agent loop writes them — user message, run start, assistant message +
 * tool calls, run end — so the time-based turn attribution is exercised against the real sequence
 * rather than a shape invented here.
 */
async function recordTurn(
  store: InMemoryAgentStore,
  turn: {
    threadId: string;
    runId: string;
    userText: string;
    assistantText: string;
    toolCalls?: { toolCallId: string; toolName: string; toolType: 'read' | 'action' }[];
    settle?: { status: 'completed' | 'failed'; errorCode?: string };
  },
): Promise<string> {
  await store.appendMessage({ threadId: turn.threadId, role: 'user', content: turn.userText });
  vi.advanceTimersByTime(1);
  await store.recordRunStart({ runId: turn.runId, threadId: turn.threadId, actorRef: 'alice' });
  vi.advanceTimersByTime(1);
  const assistant = await store.appendMessage({
    threadId: turn.threadId,
    role: 'assistant',
    content: turn.assistantText,
  });
  for (const call of turn.toolCalls ?? []) {
    await store.recordToolCall({
      toolCallId: call.toolCallId,
      messageId: assistant.id,
      toolName: call.toolName,
      toolType: call.toolType,
      input: {},
      status: call.toolType === 'action' ? 'pending_approval' : 'auto_executed',
      runId: turn.runId,
    });
  }
  await store.recordRunEnd({
    runId: turn.runId,
    status: turn.settle?.status ?? 'completed',
    durationMs: 42,
    ...(turn.settle?.errorCode !== undefined ? { errorCode: turn.settle.errorCode } : {}),
  });
  vi.advanceTimersByTime(1);
  return assistant.id;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-01T10:00:00.000Z'));
});
afterEach(() => vi.useRealTimers());

describe('GovernanceRunSampleSource', () => {
  it('assembles a run from its own turn of the transcript plus its tool-call outcomes', async () => {
    const store = new InMemoryAgentStore();
    const thread = await store.createThread({ actor: { id: 'alice' }, title: 'ops' });
    await recordTurn(store, {
      threadId: thread.id,
      runId: 'run-1',
      userText: 'how many pods are down?',
      assistantText: 'Two, in eu-west-1.',
      toolCalls: [{ toolCallId: 'tc-1', toolName: 'purgeCache', toolType: 'action' }],
    });
    await store.updateToolCall({ toolCallId: 'tc-1', status: 'rejected' });

    const source = new GovernanceRunSampleSource(new InMemoryGovernanceQueries(store), store);
    const sample = await source.getRun('run-1');

    expect(sample).toMatchObject({
      runId: 'run-1',
      threadId: thread.id,
      actorRef: 'alice',
      status: 'completed',
      input: 'how many pods are down?',
      output: 'Two, in eu-west-1.',
      durationMs: 42,
    });
    expect(sample?.toolCalls).toEqual([
      {
        toolCallId: 'tc-1',
        toolName: 'purgeCache',
        toolType: 'action',
        status: 'rejected',
        executionMs: null,
        error: null,
      },
    ]);
  });

  it('gives each turn of a thread its OWN prompt and answer', async () => {
    const store = new InMemoryAgentStore();
    const thread = await store.createThread({ actor: { id: 'alice' }, title: 'ops' });
    await recordTurn(store, {
      threadId: thread.id,
      runId: 'run-1',
      userText: 'first question',
      assistantText: 'first answer',
    });
    await recordTurn(store, {
      threadId: thread.id,
      runId: 'run-2',
      userText: 'second question',
      assistantText: 'second answer',
    });

    const source = new GovernanceRunSampleSource(new InMemoryGovernanceQueries(store), store);

    expect(await source.getRun('run-1')).toMatchObject({
      input: 'first question',
      output: 'first answer',
    });
    expect(await source.getRun('run-2')).toMatchObject({
      input: 'second question',
      output: 'second answer',
    });
  });

  it('takes the LAST assistant message of a multi-step turn as the answer', async () => {
    const store = new InMemoryAgentStore();
    const thread = await store.createThread({ actor: { id: 'alice' }, title: 'ops' });
    await recordTurn(store, {
      threadId: thread.id,
      runId: 'run-1',
      userText: 'how many pods are down?',
      assistantText: 'let me look that up',
    });
    await store.appendMessage({
      threadId: thread.id,
      role: 'assistant',
      content: 'Two, in eu-west-1.',
    });

    const source = new GovernanceRunSampleSource(new InMemoryGovernanceQueries(store), store);

    expect(await source.getRun('run-1')).toMatchObject({ output: 'Two, in eu-west-1.' });
  });

  it('reads a thread once per batch, not once per run it holds', async () => {
    const store = new CountingStore();
    const thread = await store.createThread({ actor: { id: 'alice' }, title: 'ops' });
    await recordTurn(store, {
      threadId: thread.id,
      runId: 'run-1',
      userText: 'q1',
      assistantText: 'a1',
    });
    await recordTurn(store, {
      threadId: thread.id,
      runId: 'run-2',
      userText: 'q2',
      assistantText: 'a2',
    });
    store.threadReads = 0;

    const source = new GovernanceRunSampleSource(new InMemoryGovernanceQueries(store), store);
    const samples = await source.listRuns({ limit: 10 });

    expect(samples).toHaveLength(2);
    expect(store.threadReads).toBe(1);
  });

  it('applies the query filters and returns the newest run first', async () => {
    const store = new InMemoryAgentStore();
    const thread = await store.createThread({ actor: { id: 'alice' }, title: 'ops' });
    await recordTurn(store, {
      threadId: thread.id,
      runId: 'run-ok',
      userText: 'q1',
      assistantText: 'a1',
    });
    await recordTurn(store, {
      threadId: thread.id,
      runId: 'run-bad',
      userText: 'q2',
      assistantText: '',
      settle: { status: 'failed', errorCode: 'run_failed' },
    });

    const source = new GovernanceRunSampleSource(new InMemoryGovernanceQueries(store), store);

    expect((await source.listRuns({ limit: 10 })).map((sample) => sample.runId)).toEqual([
      'run-bad',
      'run-ok',
    ]);
    expect(await source.listRuns({ limit: 10, status: 'failed' })).toMatchObject([
      { runId: 'run-bad', errorCode: 'run_failed' },
    ]);
  });

  it('still returns a run whose thread is gone, with empty text', async () => {
    const store = new InMemoryAgentStore();
    const thread = await store.createThread({ actor: { id: 'alice' }, title: 'ops' });
    await recordTurn(store, {
      threadId: thread.id,
      runId: 'run-1',
      userText: 'q1',
      assistantText: 'a1',
    });
    await store.softDeleteThread(thread.id);

    const source = new GovernanceRunSampleSource(new InMemoryGovernanceQueries(store), store);

    expect(await source.getRun('run-1')).toMatchObject({ runId: 'run-1', input: '', output: '' });
  });

  it('returns null for a run nobody recorded', async () => {
    const store = new InMemoryAgentStore();
    const source = new GovernanceRunSampleSource(new InMemoryGovernanceQueries(store), store);

    expect(await source.getRun('nope')).toBeNull();
  });
});
