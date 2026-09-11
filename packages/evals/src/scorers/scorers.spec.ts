import { FakeModelProvider } from '@dudousxd/nestjs-agent-testing';
import { describe, expect, it } from 'vitest';
import { buildApprovalPrior } from '../approval-prior.js';
import type { ScorableRun, ScorableToolCall } from '../types.js';
import { AnswerRelevancyScorer } from './answer-relevancy.scorer.js';
import { ApprovalOutcomeScorer } from './approval-outcome.scorer.js';
import { ApprovalRiskScorer } from './approval-risk.scorer.js';
import { RunCompletionScorer } from './run-completion.scorer.js';

function call(overrides: Partial<ScorableToolCall> & { toolName: string }): ScorableToolCall {
  return {
    toolCallId: `tc-${overrides.toolName}-${overrides.status ?? 'x'}`,
    toolType: 'read',
    status: 'executed',
    executionMs: 10,
    error: null,
    ...overrides,
  };
}

function run(overrides: Partial<ScorableRun> = {}): ScorableRun {
  return {
    runId: 'run-1',
    threadId: 'thread-1',
    actorRef: 'alice',
    agentName: 'ops',
    status: 'completed',
    input: 'how many pods are down?',
    output: 'Two pods are down in eu-west-1.',
    toolCalls: [],
    durationMs: 1200,
    errorCode: null,
    startedAt: '2026-09-01T10:00:00.000Z',
    ...overrides,
  };
}

describe('RunCompletionScorer', () => {
  const scorer = new RunCompletionScorer();

  it('scores a completed, answered run with healthy tools 1', async () => {
    const result = await scorer.score(run({ toolCalls: [call({ toolName: 'listPods' })] }));

    expect(result?.score).toBe(1);
    expect(result?.reason).toContain('every tool intact');
  });

  it('scores a failed run 0 and names the error code', async () => {
    const result = await scorer.score(run({ status: 'failed', errorCode: 'quota_exceeded' }));

    expect(result?.score).toBe(0);
    expect(result?.reason).toContain('quota_exceeded');
  });

  it('scores a completed run that answered nothing 0 — what the governance success rate calls a success', async () => {
    const result = await scorer.score(run({ output: '   ' }));

    expect(result?.score).toBe(0);
    expect(result?.reason).toBe('the run completed without answering anything');
  });

  it('half-scores an answer written while a tool was broken, naming the tool once', async () => {
    const result = await scorer.score(
      run({
        toolCalls: [
          call({ toolName: 'listPods', status: 'failed', error: 'timeout' }),
          call({ toolName: 'listPods', status: 'failed', error: 'timeout again' }),
          call({ toolName: 'describeNode' }),
        ],
      }),
    );

    expect(result?.score).toBe(0.5);
    expect(result?.reason).toBe('answered, but 2 of 3 tool calls failed (listPods)');
  });

  it('declines to score a run still in flight', async () => {
    expect(await scorer.score(run({ status: 'running' }))).toBeNull();
  });
});

describe('ApprovalOutcomeScorer', () => {
  const scorer = new ApprovalOutcomeScorer();

  it('reads a rejection as the negative label a human produced', async () => {
    const result = await scorer.score(
      run({
        toolCalls: [
          call({ toolName: 'purgeCache', toolType: 'action', status: 'rejected' }),
          call({ toolName: 'restartPod', toolType: 'action', status: 'executed' }),
        ],
      }),
    );

    expect(result?.score).toBe(0.5);
    expect(result?.reason).toBe('a human approved 1 of 2 decided actions (rejected: purgeCache)');
    expect(result?.metadata).toEqual({
      proposed: 2,
      approved: 1,
      rejected: 1,
      pending: 0,
      rejectedTools: ['purgeCache'],
    });
  });

  it('counts an approved-then-crashed action as approved — the human still said yes', async () => {
    const result = await scorer.score(
      run({
        toolCalls: [
          call({ toolName: 'restartPod', toolType: 'action', status: 'failed', error: 'boom' }),
        ],
      }),
    );

    expect(result?.score).toBe(1);
    expect(result?.reason).toBe('a human approved all 1 decided action');
  });

  it('declines to score a read-only run — a run nobody judged is not a perfect run', async () => {
    expect(
      await scorer.score(run({ toolCalls: [call({ toolName: 'listPods', status: 'executed' })] })),
    ).toBeNull();
  });

  it('declines to score while every action is still awaiting a decision', async () => {
    const result = await scorer.score(
      run({
        toolCalls: [
          call({ toolName: 'purgeCache', toolType: 'action', status: 'pending_approval' }),
        ],
      }),
    );

    expect(result).toBeNull();
  });

  it('ignores a still-pending action alongside a decided one', async () => {
    const result = await scorer.score(
      run({
        toolCalls: [
          call({ toolName: 'purgeCache', toolType: 'action', status: 'pending_approval' }),
          call({ toolName: 'restartPod', toolType: 'action', status: 'executed' }),
        ],
      }),
    );

    expect(result?.score).toBe(1);
    expect(result?.metadata).toMatchObject({ proposed: 2, approved: 1, rejected: 0, pending: 1 });
  });
});

describe('ApprovalRiskScorer', () => {
  const prior = buildApprovalPrior([
    { toolName: 'purgeCache', status: 'rejected' },
    { toolName: 'purgeCache', status: 'rejected' },
    { toolName: 'purgeCache', status: 'rejected' },
    { toolName: 'restartPod', status: 'executed' },
    { toolName: 'restartPod', status: 'executed' },
  ]);
  const scorer = new ApprovalRiskScorer(prior);

  it('scores a run by its RISKIEST action, not the average of them', async () => {
    const result = await scorer.score(
      run({
        toolCalls: [
          call({ toolName: 'restartPod', toolType: 'action', status: 'pending_approval' }),
          call({ toolName: 'purgeCache', toolType: 'action', status: 'pending_approval' }),
        ],
      }),
    );

    // purgeCache: (0+1)/(3+2) = 0.2, restartPod: (2+1)/(2+2) = 0.75 — the run is as risky as 0.2.
    expect(result?.score).toBeCloseTo(0.2, 10);
    expect(result?.reason).toBe(
      'the riskiest proposed action is purgeCache — humans approved 0 of its 3 past calls',
    );
    expect(result?.metadata).toMatchObject({ riskiestTool: 'purgeCache' });
  });

  it('sits a never-decided tool at exactly 0.5 — no evidence either way', async () => {
    const result = await scorer.score(
      run({
        toolCalls: [
          call({ toolName: 'rotateSecrets', toolType: 'action', status: 'pending_approval' }),
        ],
      }),
    );

    expect(result?.score).toBe(0.5);
    expect(result?.reason).toContain('no human has ever decided on rotateSecrets');
  });

  it('declines to score a run that proposed no action', async () => {
    expect(
      await scorer.score(run({ toolCalls: [call({ toolName: 'listPods', status: 'executed' })] })),
    ).toBeNull();
  });
});

describe('AnswerRelevancyScorer', () => {
  it('normalizes the judge band onto 0..1 and keeps its reason', async () => {
    const scorer = new AnswerRelevancyScorer({
      model: new FakeModelProvider(() => ({
        text: 'SCORE: 4\nREASON: answers the question but omits the region.',
      })),
    });

    const result = await scorer.score(run());

    expect(result?.score).toBe(0.8);
    expect(result?.reason).toBe('answers the question but omits the region.');
    expect(result?.metadata).toEqual({ rawScore: 4, maxScore: 5 });
  });

  it('puts the question and the answer in front of the judge', async () => {
    const seen: string[] = [];
    const scorer = new AnswerRelevancyScorer({
      model: new FakeModelProvider((args) => {
        seen.push(args.messages.map((message) => message.content).join(''));
        return { text: 'SCORE: 5\nREASON: perfect.' };
      }),
    });

    await scorer.score(run({ input: 'how many pods?', output: 'two' }));

    expect(seen[0]).toContain('QUESTION:\nhow many pods?');
    expect(seen[0]).toContain('ANSWER:\ntwo');
  });

  it('declines to grade a run with no answer instead of asking the judge', async () => {
    let calls = 0;
    const scorer = new AnswerRelevancyScorer({
      model: new FakeModelProvider(() => {
        calls += 1;
        return { text: 'SCORE: 0\nREASON: nothing.' };
      }),
    });

    expect(await scorer.score(run({ output: '' }))).toBeNull();
    expect(calls).toBe(0);
  });

  it('throws rather than scoring 0 when the judge answers with prose', async () => {
    const scorer = new AnswerRelevancyScorer({
      model: new FakeModelProvider(() => ({ text: 'I think it was pretty good actually.' })),
    });

    await expect(scorer.score(run())).rejects.toThrow(/carried no "SCORE:" line/);
  });
});
