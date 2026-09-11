import { InMemoryAgentStore, InMemoryGovernanceQueries } from '@dudousxd/nestjs-agent-testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadApprovalPrior } from './approval-prior.js';
import { runEvaluation } from './evaluate.js';
import { GovernanceRunSampleSource } from './governance-sample-source.js';
import { InMemoryScoreStore } from './in-memory-score-store.js';
import { ApprovalOutcomeScorer } from './scorers/approval-outcome.scorer.js';
import { ApprovalRiskScorer } from './scorers/approval-risk.scorer.js';
import { RunCompletionScorer } from './scorers/run-completion.scorer.js';
import { summarizeByScorer, worstScoredRuns } from './summarize.js';

/** Records one turn the way the agent loop does, ending with a HITL decision on its action tool. */
async function recordHitlTurn(
  store: InMemoryAgentStore,
  turn: { threadId: string; runId: string; toolName: string; decision: 'executed' | 'rejected' },
): Promise<void> {
  await store.appendMessage({ threadId: turn.threadId, role: 'user', content: 'clear the cache' });
  vi.advanceTimersByTime(1);
  await store.recordRunStart({ runId: turn.runId, threadId: turn.threadId, actorRef: 'alice' });
  vi.advanceTimersByTime(1);
  const assistant = await store.appendMessage({
    threadId: turn.threadId,
    role: 'assistant',
    content: `running ${turn.toolName}`,
  });
  const toolCallId = `tc-${turn.runId}`;
  await store.recordToolCall({
    toolCallId,
    messageId: assistant.id,
    toolName: turn.toolName,
    toolType: 'action',
    input: {},
    status: 'pending_approval',
    runId: turn.runId,
  });
  await store.updateToolCall({ toolCallId, status: turn.decision });
  await store.recordRunEnd({ runId: turn.runId, status: 'completed', durationMs: 10 });
  vi.advanceTimersByTime(1);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-01T10:00:00.000Z'));
});
afterEach(() => vi.useRealTimers());

describe('an offline backfill over a store', () => {
  it('turns the HITL decisions a human already made into a quality trend', async () => {
    const store = new InMemoryAgentStore();
    const thread = await store.createThread({ actor: { id: 'alice' }, title: 'ops' });
    await recordHitlTurn(store, {
      threadId: thread.id,
      runId: 'run-ok',
      toolName: 'restartPod',
      decision: 'executed',
    });
    await recordHitlTurn(store, {
      threadId: thread.id,
      runId: 'run-rejected',
      toolName: 'purgeCache',
      decision: 'rejected',
    });

    const queries = new InMemoryGovernanceQueries(store);
    const scoreStore = new InMemoryScoreStore();
    const summary = await runEvaluation({
      source: new GovernanceRunSampleSource(queries, store),
      scorers: [
        new RunCompletionScorer(),
        new ApprovalOutcomeScorer(),
        new ApprovalRiskScorer(await loadApprovalPrior(queries)),
      ],
      store: scoreStore,
      query: { limit: 100 },
    });

    expect(summary).toMatchObject({ runsRead: 2, runsScored: 2, scoresRecorded: 6, failures: [] });

    const approval = await scoreStore.listScores({ scorer: 'approval-outcome' });
    expect(
      approval
        .map((row) => [row.runId, row.score])
        .sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
    ).toEqual([
      ['run-ok', 1],
      ['run-rejected', 0],
    ]);

    // The rejection is the worst thing that happened, and it says why without a second read.
    const [worst] = worstScoredRuns(await scoreStore.listScores({}), 1);
    expect(worst).toMatchObject({ runId: 'run-rejected', scorer: 'approval-outcome', score: 0 });
    expect(worst?.reason).toContain('rejected: purgeCache');

    // Both turns answered, so the completion signal stays clean while approval quality is halved —
    // exactly the split a single "success rate" cannot show.
    const byScorer = new Map(
      summarizeByScorer(await scoreStore.listScores({})).map((row) => [row.scorer, row]),
    );
    expect(byScorer.get('run-completion')).toMatchObject({ samples: 2, meanScore: 1 });
    expect(byScorer.get('approval-outcome')).toMatchObject({ samples: 2, meanScore: 0.5 });
  });
});
