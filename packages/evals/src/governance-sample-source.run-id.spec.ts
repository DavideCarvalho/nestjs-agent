import { InMemoryAgentStore, InMemoryGovernanceQueries } from '@dudousxd/nestjs-agent-testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GovernanceRunSampleSource } from './governance-sample-source.js';

/** The loop's write order for one turn, optionally stamping each message with the run that wrote it. */
async function recordTurn(
  store: InMemoryAgentStore,
  queries: InMemoryGovernanceQueries,
  turn: {
    threadId: string;
    runId: string;
    userText: string;
    assistantText: string;
    stamp: boolean;
  },
): Promise<string> {
  const stamp = turn.stamp ? { runId: turn.runId } : {};
  await store.appendMessage({
    threadId: turn.threadId,
    role: 'user',
    content: turn.userText,
    ...stamp,
  });
  vi.advanceTimersByTime(1);
  await store.recordRunStart({ runId: turn.runId, threadId: turn.threadId, actorRef: 'alice' });
  vi.advanceTimersByTime(1);
  const assistant = await store.appendMessage({
    threadId: turn.threadId,
    role: 'assistant',
    content: turn.assistantText,
    ...stamp,
  });
  await store.recordRunEnd({ runId: turn.runId, status: 'completed', durationMs: 42 });
  vi.advanceTimersByTime(1);
  void queries;
  return assistant.id;
}

describe('GovernanceRunSampleSource — attributing a turn to the run that produced it', () => {
  let store: InMemoryAgentStore;
  let queries: InMemoryGovernanceQueries;
  let source: GovernanceRunSampleSource;
  let threadId: string;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-14T10:00:00.000Z'));
    store = new InMemoryAgentStore();
    queries = new InMemoryGovernanceQueries(store);
    source = new GovernanceRunSampleSource(queries, store);
    threadId = (await store.createThread({ actor: { id: 'alice', roles: ['ADMIN'] } })).id;
    vi.advanceTimersByTime(1);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads each run its own prompt and answer when both sit in one thread', async () => {
    await recordTurn(store, queries, {
      threadId,
      runId: 'run-1',
      userText: 'first question',
      assistantText: 'first answer',
      stamp: true,
    });
    await recordTurn(store, queries, {
      threadId,
      runId: 'run-2',
      userText: 'second question',
      assistantText: 'second answer',
      stamp: true,
    });

    expect(await source.getRun('run-1')).toMatchObject({
      input: 'first question',
      output: 'first answer',
    });
    expect(await source.getRun('run-2')).toMatchObject({
      input: 'second question',
      output: 'second answer',
    });
  });

  it('does not hand a regenerated turn the replacement answer', async () => {
    const replaced = await recordTurn(store, queries, {
      threadId,
      runId: 'run-1',
      userText: 'a question',
      assistantText: 'the answer nobody liked',
      stamp: true,
    });
    // Regenerating truncates the replaced answer and re-runs THE SAME prompt — no second user
    // message is written. So the transcript ends up as one user message followed by run-2's answer,
    // and walking forward from that prompt by time reaches run-2's text no matter which run asked.
    await store.truncateFrom(threadId, replaced);
    await store.recordRunStart({ runId: 'run-2', threadId, actorRef: 'alice' });
    vi.advanceTimersByTime(1);
    await store.appendMessage({
      threadId,
      role: 'assistant',
      content: 'the regenerated answer',
      runId: 'run-2',
    });
    await store.recordRunEnd({ runId: 'run-2', status: 'completed', durationMs: 42 });

    expect(await source.getRun('run-1')).toMatchObject({ output: '' });
    // run-2 stamped no user message of its own, but the prompt it answered is right there.
    expect(await source.getRun('run-2')).toMatchObject({
      input: 'a question',
      output: 'the regenerated answer',
    });
  });

  it('still attributes by time on a transcript written before the stamp existed', async () => {
    await recordTurn(store, queries, {
      threadId,
      runId: 'run-1',
      userText: 'an old question',
      assistantText: 'an old answer',
      stamp: false,
    });

    expect(await source.getRun('run-1')).toMatchObject({
      input: 'an old question',
      output: 'an old answer',
    });
  });
});
