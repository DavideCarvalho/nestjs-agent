import { Suspend } from '@dudousxd/durable-worker';
import type { AgentRunInput } from '@dudousxd/nestjs-agent-core';
import { InMemoryAgentStore, InMemoryTokenStreamSink } from '@dudousxd/nestjs-agent-testing';
import type { WorkflowService } from '@dudousxd/nestjs-durable';
import type { RunGateway } from '@dudousxd/nestjs-durable-core';
import { WorkflowSuspended } from '@dudousxd/nestjs-durable-core';
import { describe, expect, it, vi } from 'vitest';
import { DurableAgentRunner } from './durable-agent-runner.js';

function runInput(): AgentRunInput {
  return {
    threadId: 'thr-1',
    actor: { id: 'actor-1', roles: [] },
    userText: 'hi',
    day: '2026-07-10',
  };
}

/** `start` reaches for none of these; calling one is the test's own mistake, not a fake's gap. */
function unreached(): never {
  throw new Error('DurableAgentRunner.start must not touch the run gateway');
}

const runGateway: RunGateway = {
  topology: unreached,
  getRunDetail: unreached,
  listRuns: unreached,
  waitingFor: unreached,
  workerHealth: unreached,
  cancel: unreached,
  retry: unreached,
  continue: unreached,
  redispatchPending: unreached,
  retryWithInput: unreached,
  subscribe: unreached,
};

function runnerWith(start: WorkflowService['start']): DurableAgentRunner {
  const workflows = { start, signal: vi.fn() } as unknown as WorkflowService;
  return new DurableAgentRunner(
    workflows,
    runGateway,
    new InMemoryAgentStore(),
    new InMemoryTokenStreamSink(),
  );
}

describe('DurableAgentRunner.start', () => {
  it('returns the run id even when the run suspends synchronously on start', async () => {
    // A driving dispatcher (durable tenant/worker) surfaces the engine's internal suspend signal out
    // of `start`; that is expected control flow, so `start` must still hand back the run id.
    const start = vi.fn(async () => {
      throw new WorkflowSuspended(Date.now() + 1000);
    });
    const runner = runnerWith(start as unknown as WorkflowService['start']);

    const { runId } = await runner.start(runInput());

    expect(typeof runId).toBe('string');
    expect(runId.length).toBeGreaterThan(0);
    // The generated id is the one handed to the engine, so the sink/stream key matches the run.
    expect(start).toHaveBeenCalledWith(expect.anything(), expect.anything(), runId);
  });

  it("returns the run id when the thin-worker runtime's OWN Suspend class surfaces on start", async () => {
    // durable-worker's Suspend is a different class from durable-core's WorkflowSuspended — only
    // the Symbol.for control-flow marker is shared, so an instanceof check here would rethrow it
    // as a start failure. Same cross-runtime hazard the workflow's catch had.
    const start = vi.fn(async () => {
      throw new Suspend();
    });
    const runner = runnerWith(start as unknown as WorkflowService['start']);

    const { runId } = await runner.start(runInput());

    expect(typeof runId).toBe('string');
    expect(runId.length).toBeGreaterThan(0);
  });

  it('propagates a real start failure (not a suspend)', async () => {
    const start = vi.fn(async () => {
      throw new Error('store unavailable');
    });
    const runner = runnerWith(start as unknown as WorkflowService['start']);

    await expect(runner.start(runInput())).rejects.toThrow('store unavailable');
  });

  it('returns the run id on a clean (non-suspending) start', async () => {
    const start = vi.fn(async () => ({ runId: 'ignored', status: 'pending' }));
    const runner = runnerWith(start as unknown as WorkflowService['start']);

    const { runId } = await runner.start(runInput());
    // The runner owns the id it passed to the engine — not whatever the result echoes back.
    expect(start).toHaveBeenCalledWith(expect.anything(), expect.anything(), runId);
  });
});
