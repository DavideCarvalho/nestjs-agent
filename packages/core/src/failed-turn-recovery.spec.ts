import { afterEach, describe, expect, it } from 'vitest';
import {
  RUN_FAILED_MESSAGE,
  agentFailureCode,
  exposeStreamErrorDetails,
  streamFailure,
  toolCallContext,
} from './agent-loop.js';
import {
  RUN_ENDED_BEFORE_TOOL_CALL,
  UNFINISHED_TOOL_CALL,
  danglingToolCallIds,
  settleDanglingToolCalls,
} from './dangling-tool-calls.js';
import { settleDeadRun } from './dead-run.js';
import { InMemoryAgentStore } from './in-memory-store.js';
import type { ModelMessage } from './types.js';

class NonDeterminismError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonDeterminismError';
  }
}

afterEach(() => exposeStreamErrorDetails(undefined));

describe('settleDanglingToolCalls', () => {
  const asking: ModelMessage = {
    role: 'assistant',
    content: 'saving',
    toolCalls: [
      { id: 'a', name: 'save_exam', input: {} },
      { id: 'b', name: 'record_measure', input: {} },
      { id: 'c', name: 'delete_all', input: {} },
      { id: 'd', name: 'late', input: {} },
    ],
  };

  it('answers each dangling call with what its row says happened', () => {
    expect(danglingToolCallIds([asking])).toEqual(['a', 'b', 'c', 'd']);
    const [healed] = settleDanglingToolCalls(
      [asking],
      [
        { id: 'a', status: 'executed', output: { saved: true } },
        { id: 'c', status: 'rejected' },
        { id: 'd', status: 'expired' },
      ],
    );
    expect(healed?.toolResults).toEqual([
      { id: 'a', name: 'save_exam', output: { saved: true } },
      { id: 'b', name: 'record_measure', output: null, error: UNFINISHED_TOOL_CALL },
      expect.objectContaining({ id: 'c', denied: true }),
      expect.objectContaining({ id: 'd', denied: true, expired: true }),
    ]);
  });

  it('keeps the results a message already has, and leaves a whole history untouched', () => {
    const partial: ModelMessage = {
      ...asking,
      toolResults: [{ id: 'a', name: 'save_exam', output: 1 }],
    };
    const [healed] = settleDanglingToolCalls([partial]);
    expect(healed?.toolResults?.map((result) => result.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(healed?.toolResults?.[0]).toEqual({ id: 'a', name: 'save_exam', output: 1 });

    const whole: ModelMessage[] = [{ role: 'user', content: 'hi' }, healed as ModelMessage];
    expect(danglingToolCallIds(whole)).toEqual([]);
    expect(settleDanglingToolCalls(whole)).toEqual(whole);
    expect(settleDanglingToolCalls(whole)[1]).toBe(whole[1]);
  });
});

describe('streamFailure', () => {
  it('keeps internals off the frame in production, and the code stable', () => {
    exposeStreamErrorDetails(false);
    const noOutput = new Error('No output generated. Check the stream for errors.');
    noOutput.name = 'AI_NoOutputGeneratedError';
    expect(streamFailure(noOutput)).toEqual({
      code: 'model_no_output',
      message: RUN_FAILED_MESSAGE,
    });
    // An error that crossed a dispatched step keeps its message, not always its class name.
    expect(agentFailureCode(new Error('No output generated. Check the stream for errors.'))).toBe(
      'model_no_output',
    );
    expect(streamFailure(new NonDeterminismError('non-determinism at r#41'))).toEqual({
      code: 'replay_diverged',
      message: RUN_FAILED_MESSAGE,
    });
    expect(streamFailure(new Error('connection reset by peer 10.0.0.7:5432'))).toEqual({
      code: 'run_failed',
      message: RUN_FAILED_MESSAGE,
    });
  });

  it('carries the error itself where the reader is the one debugging it', () => {
    exposeStreamErrorDetails(true);
    expect(streamFailure(new Error('boom'))).toEqual({ code: 'run_failed', message: 'boom' });
  });

  it('follows NODE_ENV when nothing was decided', () => {
    const before = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      expect(streamFailure(new Error('boom')).message).toBe(RUN_FAILED_MESSAGE);
      process.env.NODE_ENV = 'development';
      expect(streamFailure(new Error('boom')).message).toBe('boom');
    } finally {
      process.env.NODE_ENV = before;
    }
  });
});

describe('toolCallContext', () => {
  it('names the call and a key that is the same for every execution of it', () => {
    expect(toolCallContext({ runId: 'r1', threadId: 't1' }, 'call-0-save')).toEqual({
      runId: 'r1',
      threadId: 't1',
      toolCallId: 'call-0-save',
      idempotencyKey: 'r1:call-0-save',
    });
  });
});

describe('settleDeadRun', () => {
  async function seeded() {
    const store = new InMemoryAgentStore();
    const actor = { id: 'u1', roles: [] };
    const thread = await store.createThread({ actor });
    const message = await store.appendMessage({
      threadId: thread.id,
      role: 'assistant',
      content: '',
    });
    await store.recordRunStart({ runId: 'r1', threadId: thread.id, actorRef: 'u1' });
    for (const [toolCallId, status, runId] of [
      ['waiting', 'pending_approval', 'r1'],
      ['done', 'executed', 'r1'],
      ['other-run', 'pending_approval', 'r2'],
    ] as const) {
      await store.recordToolCall({
        toolCallId,
        messageId: message.id,
        toolName: 'purge',
        toolType: 'action',
        input: {},
        status,
        runId,
      });
    }
    await store.setActiveStream(thread.id, 'r1');
    return { store, threadId: thread.id };
  }

  it('fails only the calls the run left awaiting a decision, and leaves its row alone', async () => {
    const { store, threadId } = await seeded();
    await settleDeadRun(store, { runId: 'r1' });
    expect(store.toolCallRows().map((row) => [row.toolCallId, row.status, row.error])).toEqual([
      ['waiting', 'failed', RUN_ENDED_BEFORE_TOOL_CALL],
      ['done', 'executed', undefined],
      ['other-run', 'pending_approval', undefined],
    ]);
    // Not told the run failed, so its row is not rewritten — it may have completed.
    expect(store.governanceRuns()[0]?.status).toBe('running');
    expect(await store.activeRunForThread(threadId)).toBe('r1');
    expect(await store.toolCallOutcomes(['waiting', 'done', 'missing'])).toEqual([
      { id: 'waiting', status: 'failed', error: RUN_ENDED_BEFORE_TOOL_CALL },
      { id: 'done', status: 'executed' },
    ]);
  });

  it('settles the row and the thread for a caller that knows the run failed', async () => {
    const { store, threadId } = await seeded();
    const input = { runId: 'r1', threadId, failure: { code: 'replay_diverged', message: 'x' } };
    await settleDeadRun(store, input);
    await settleDeadRun(store, input);
    expect(store.governanceRuns()[0]).toMatchObject({
      status: 'failed',
      errorCode: 'replay_diverged',
      errorMessage: 'x',
    });
    expect(await store.activeRunForThread(threadId)).toBeNull();
  });
});
