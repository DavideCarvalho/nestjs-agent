import { Suspend } from '@dudousxd/durable-worker';
import type { AgentRunInput, AgentStore, TokenStreamSink } from '@dudousxd/nestjs-agent-core';
import { InMemoryAgentStore, InMemoryTokenStreamSink } from '@dudousxd/nestjs-agent-testing';
import type { WorkflowService } from '@dudousxd/nestjs-durable';
import type { RunDetail, RunGateway } from '@dudousxd/nestjs-durable-core';
import { WorkflowSuspended } from '@dudousxd/nestjs-durable-core';
import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InProcessTokenStreamSink } from '../in-process-sink.js';
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

/** The run row as the runtime recorded it — `input` is the `AgentRunInput` the run was started with. */
function detail(runId: string, input: unknown): RunDetail {
  return {
    run: {
      id: runId,
      workflow: 'agent.run',
      workflowVersion: '1',
      status: 'cancelling',
      input,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    timeline: [],
    children: [],
  };
}

function cancellingRunner(
  gateway: Partial<RunGateway>,
  store: AgentStore,
  sink: TokenStreamSink = new InMemoryTokenStreamSink(),
): DurableAgentRunner {
  const workflows = { start: vi.fn(), signal: vi.fn() } as unknown as WorkflowService;
  return new DurableAgentRunner(workflows, { ...runGateway, ...gateway }, store, sink);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('DurableAgentRunner.cancel', () => {
  it('releases the thread the cancelled run was streaming', async () => {
    const store = new InMemoryAgentStore();
    const thread = await store.createThread({ actor: { id: 'u1', roles: [] } });
    await store.setActiveStream(thread.id, 'run-1');
    const runner = cancellingRunner(
      {
        getRunDetail: async (runId) => detail(runId, { threadId: thread.id }),
        cancel: async () => null,
      },
      store,
    );

    await runner.cancel('run-1');

    // The turn was suspended on a dispatched step, so its own catch never ran — without this the
    // thread reports a live stream for a run that has stopped, and a client reattaches to it.
    expect(await store.activeRunForThread(thread.id)).toBeNull();
  });

  it('still settles a run whose input the gateway cannot supply', async () => {
    const store = new InMemoryAgentStore();
    const released = vi.spyOn(store, 'setActiveStream');
    const cancel = vi.fn(async () => null);
    const runner = cancellingRunner({ getRunDetail: async () => null, cancel }, store);

    await runner.cancel('run-gone');

    // No thread is named, so none is released — and nothing is guessed at. The cancel itself still
    // reaches the runtime, which is what stops the run.
    expect(released).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledWith('run-gone', { compensate: true });
  });
});

describe('the durable runner’s sink check', () => {
  it('warns when a durable deployment keeps the in-process sink', () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    cancellingRunner({}, new InMemoryAgentStore(), new InProcessTokenStreamSink());

    // A turn runs on whichever worker takes `agent.run` and dispatches its model call from there,
    // so a buffer in THIS process's memory is reachable from neither.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('InProcessTokenStreamSink'));
  });

  it('says nothing about a sink the host wired itself', () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    cancellingRunner({}, new InMemoryAgentStore(), new InMemoryTokenStreamSink());

    // The SPI carries no "am I cross-process" capability, so a custom sink is taken at its word
    // rather than warned about on every boot.
    expect(warn).not.toHaveBeenCalled();
  });
});
