import {
  AGENT_DIAGNOSTIC_EVENTS,
  publishAgentDelegated,
  publishAgentMessage,
  publishAgentQuotaExceeded,
  publishAgentRetrieved,
  publishAgentRunFailed,
  publishAgentRunFinished,
  publishAgentRunStarted,
  publishAgentToolCall,
} from '@dudousxd/nestjs-agent-core';
import type { WatcherContext } from '@dudousxd/nestjs-telescope';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentTelescopeWatcher } from './agent-telescope.watcher.js';

let watcher: AgentTelescopeWatcher;

afterEach(() => watcher?.dispose());

function mockCtx() {
  return { record: vi.fn() } as unknown as WatcherContext & { record: ReturnType<typeof vi.fn> };
}

describe('AgentTelescopeWatcher', () => {
  it('declares the agent entry type', () => {
    expect(new AgentTelescopeWatcher().type).toBe('agent');
  });

  it('subscribes all 8 AGENT_DIAGNOSTIC_EVENTS and records a tagged entry for each', () => {
    expect(AGENT_DIAGNOSTIC_EVENTS).toHaveLength(8);

    const ctx = mockCtx();
    watcher = new AgentTelescopeWatcher();
    watcher.register(ctx);

    publishAgentRunStarted({ runId: 'r1', threadId: 't1', actorId: 'u1' });
    publishAgentMessage({ runId: 'r1', threadId: 't1', role: 'user', textLength: 3 });
    publishAgentToolCall({ runId: 'r1', toolName: 'search', toolType: 'read', status: 'executed' });
    publishAgentQuotaExceeded({ actorId: 'u1', usedTokens: 100, limitTokens: 50 });
    publishAgentRunFinished({
      runId: 'r1',
      threadId: 't1',
      steps: 2,
      inputTokens: 10,
      outputTokens: 20,
    });
    // Previously not recorded by the hand-written literal — now covered via AGENT_DIAGNOSTIC_EVENTS.
    publishAgentRunFailed({ runId: 'r1', code: 'run_failed', message: 'boom' });
    publishAgentDelegated({ runId: 'r1', toAgent: 'triage' });
    publishAgentRetrieved({ runId: 'r1', query: 'q', count: 3 });

    expect(ctx.record).toHaveBeenCalledTimes(8);
    const events = ctx.record.mock.calls.map(
      ([input]) => (input.content as { event: string }).event,
    );
    expect(events).toEqual(AGENT_DIAGNOSTIC_EVENTS);
    expect(ctx.record.mock.calls.every(([input]) => input.type === 'agent')).toBe(true);
    expect(ctx.record.mock.calls.every(([input]) => Array.isArray(input.tags))).toBe(true);

    const failedCall = ctx.record.mock.calls.find(
      ([input]) => (input.content as { event: string }).event === 'run.failed',
    );
    expect(failedCall?.[0].tags).toEqual(['run.failed']);
    expect(failedCall?.[0].content).toMatchObject({
      event: 'run.failed',
      runId: 'r1',
      code: 'run_failed',
      message: 'boom',
    });
  });

  it('stops recording after dispose (detaches every subscription)', () => {
    const ctx = mockCtx();
    watcher = new AgentTelescopeWatcher();
    watcher.register(ctx);
    watcher.dispose();

    publishAgentRunStarted({ runId: 'r1', threadId: 't1', actorId: 'u1' });
    publishAgentRunFailed({ runId: 'r1', code: 'run_failed', message: 'boom' });
    publishAgentDelegated({ runId: 'r1', toAgent: 'triage' });
    publishAgentRetrieved({ runId: 'r1', query: 'q', count: 3 });

    expect(ctx.record).not.toHaveBeenCalled();
  });
});
