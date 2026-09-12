import { randomUUID } from 'node:crypto';
import {
  AGENT_SINK,
  AGENT_STORE,
  type AgentRunInput,
  type AgentRunner,
  type AgentStore,
  type HumanReply,
  type TokenStreamSink,
  encodeStreamEvent,
} from '@dudousxd/nestjs-agent-core';
import { RUN_GATEWAY, WorkflowService } from '@dudousxd/nestjs-durable';
import { type RunGateway, isWorkflowControlFlowSignal } from '@dudousxd/nestjs-durable-core';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { utcDay } from '../agent-deps.js';
import { InProcessTokenStreamSink } from '../in-process-sink.js';
import { AgentRunWorkflow } from './agent-run.workflow.js';

/**
 * The thread a run was streaming, read back off the input the runtime recorded when it started —
 * `AgentRunInput.threadId`, structurally, since the runtime stores a run's input as `unknown`.
 * `undefined` for anything that is not an agent run, or a run the gateway no longer has.
 */
function threadOfRun(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null || !('threadId' in input)) {
    return undefined;
  }
  return typeof input.threadId === 'string' ? input.threadId : undefined;
}

/**
 * Runs the agent turn as a `@dudousxd/nestjs-durable` workflow. `start` creates the run and returns
 * its id immediately; a worker runs the body and streams tokens to the sink. Everything a human
 * sends back into a parked run — a HITL approval, or the answers to a question set — is delivered as
 * a durable signal namespaced by run, so it can never cross-resolve another run.
 */
@Injectable()
export class DurableAgentRunner implements AgentRunner {
  private readonly logger = new Logger(DurableAgentRunner.name);

  constructor(
    private readonly workflows: WorkflowService,
    // The runtime's own read/control surface, bound by `DurableModule` under BOTH topologies — the
    // store-backed gateway on an operator, a transport proxy on a tenant. `WorkflowService` has no
    // cancel, and reaching for `WorkflowEngine` instead would work only on the operator.
    @Inject(RUN_GATEWAY) private readonly runs: RunGateway,
    @Inject(AGENT_STORE) private readonly store: AgentStore,
    @Inject(AGENT_SINK) private readonly sink: TokenStreamSink,
  ) {
    // A durable turn runs on whichever worker takes `agent.run`, and its model call is dispatched
    // again from there — so the process holding the reader's SSE connection is generally not the
    // one writing tokens. The default sink only buffers in this process's memory, which cannot be
    // reached from either. Detectable only via `instanceof`: the sink SPI carries no "am I
    // cross-process" capability, so this is silent for any custom sink (which may well be one).
    if (this.sink instanceof InProcessTokenStreamSink) {
      this.logger.warn(
        'durable: true with the default InProcessTokenStreamSink, which only buffers tokens in ' +
          'this process. The worker that runs the turn — and the one that serves its dispatched ' +
          '`llm` step — cannot stream into this buffer. Wire a cross-process TokenStreamSink ' +
          '(e.g. a Redis pub/sub sink) via AgentModule.forRoot({ sink }) before running multi-pod.',
      );
    }
  }

  async start(input: AgentRunInput): Promise<{ runId: string }> {
    const stamped: AgentRunInput = { ...input, day: input.day ?? utcDay() };
    // Own the run id so we can still return it when the run suspends synchronously (below).
    const runId = randomUUID();
    try {
      await this.workflows.start(AgentRunWorkflow, stamped, runId);
    } catch (error) {
      // A run that suspends on its FIRST step (waiting on the model/tool worker, a signal, or a
      // sleep) surfaces the runtime's internal suspend signal here whenever the start ran under a
      // DRIVING dispatcher (e.g. a durable tenant/worker) rather than the enqueue-only one. That is
      // expected control flow, NOT a failure: the run is already persisted and a worker will resume
      // it, while the caller streams the sink meanwhile. Swallow it and return the run id; any
      // other error is a real start failure and propagates. Marker-based predicate, NOT instanceof:
      // the signal's CLASS differs by runtime (engine in-process WorkflowSuspended vs the BullMQ
      // thin worker's own Suspend), so only the Symbol.for marker is reliable.
      if (!isWorkflowControlFlowSignal(error)) {
        throw error;
      }
    }
    return { runId };
  }

  async signal(runId: string, toolCallId: string, reply: HumanReply): Promise<void> {
    await this.workflows.signal(`tool:${runId}:${toolCallId}`, reply);
  }

  /**
   * Stop a run, and settle what the durable runtime knows nothing about.
   *
   * `compensate: true` is the form that gives the BODY a chance: it moves the run to `cancelling`
   * (which is what the workflow's own cancel observation reads) and then re-drives it, so a turn
   * running in-process unwinds at its next safe point instead of finishing. It also guarantees the
   * outcome for the turn that CANNOT observe anything — one parked on `waitForSignal`, suspended
   * inside a position its journal already holds — because that re-drive re-suspends and the runtime
   * settles the run `cancelled` regardless. The cascade to child runs comes with it.
   *
   * Neither of those settles the agent's own state, so this does: the run row gets its own terminal,
   * the thread stops reporting a live stream, and the subscriber gets a `cancelled` frame followed
   * by a normal end.
   *
   * The thread is released HERE rather than left to the body, because a cancelled turn is usually
   * suspended — parked on a human, or on one of the dispatched steps a turn spends most of its life
   * in — and a suspended body never reaches its own catch: the runtime settles the run from outside
   * it. The body still releases the thread on the paths where it does unwind (see
   * `AgentRunWorkflow`); both write the same `null`, and whichever gets there first is right. The
   * thread id comes off the run's own recorded input, so this holds for a sub-agent's subthread too
   * — read best-effort, because a gateway that cannot name the thread must not stop the cancel.
   *
   * A tool already executing is not interrupted, here or anywhere: see `haltIfCancelled` in core.
   */
  async cancel(runId: string): Promise<void> {
    this.logger.log(`cancelling agent run ${runId}`);
    const threadId = await this.threadOf(runId);
    await this.runs.cancel(runId, { compensate: true });
    if (threadId !== undefined) {
      await this.store.setActiveStream(threadId, null);
    }
    const writer = await this.sink.open(runId);
    await writer.write(encodeStreamEvent({ kind: 'cancelled' }));
    await writer.end();
    await this.store.recordRunEnd?.({ runId, status: 'cancelled' });
  }

  /**
   * Which thread a run was streaming, or `undefined` where the gateway cannot say.
   *
   * A read failure answers `undefined` instead of propagating, the same posture `AgentRunWorkflow`
   * takes for its own cancel observation: failing to ask is not an answer worth failing a cancel
   * over. This id is only needed to clear the thread's active stream, and a stream still marked live
   * is a far smaller fault than the one a throw here would cause — a run nobody ever told to stop,
   * with a subscriber holding a stream that never settles, from the one call whose entire job is to
   * make a run stop.
   */
  private async threadOf(runId: string): Promise<string | undefined> {
    try {
      return threadOfRun((await this.runs.getRunDetail(runId))?.run.input);
    } catch {
      return undefined;
    }
  }
}
