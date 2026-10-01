import { randomUUID } from 'node:crypto';
import {
  AGENT_SINK,
  AGENT_STORE,
  type AgentRunInput,
  type AgentRunStartOptions,
  type AgentRunner,
  type AgentStore,
  type DetachedDelivery,
  type HumanReply,
  type TokenStreamSink,
  encodeStreamEvent,
  releaseThreadRun,
  settleUnsettledDelegation,
} from '@dudousxd/nestjs-agent-core';
import { RUN_GATEWAY, WorkflowService } from '@dudousxd/nestjs-durable';
import {
  type RunDetail,
  type RunGateway,
  isWorkflowControlFlowSignal,
} from '@dudousxd/nestjs-durable-core';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { utcDay } from '../agent-deps.js';
import { InProcessTokenStreamSink } from '../in-process-sink.js';
import type { ChatQueueService } from '../queue/chat-queue.service.js';
import { AGENT_CHAT_QUEUE } from '../queue/chat-queue.token.js';
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

/** A thread's own turn, read structurally off a recorded input — see {@link threadOfRun}. */
function isThreadTurn(input: unknown): boolean {
  return (
    typeof input === 'object' &&
    input !== null &&
    (input as { sinkRunId?: unknown }).sinkRunId === undefined &&
    (input as { deliverTo?: unknown }).deliverTo === undefined
  );
}

/** Where a DETACHED run delivers, read structurally off a recorded input; `undefined` for any other run. */
function deliveryOf(input: unknown): { delivery: DetachedDelivery; agent: string } | undefined {
  if (typeof input !== 'object' || input === null) {
    return undefined;
  }
  const { deliverTo, agentName } = input as { deliverTo?: unknown; agentName?: unknown };
  if (
    typeof deliverTo !== 'object' ||
    deliverTo === null ||
    typeof (deliverTo as { threadId?: unknown }).threadId !== 'string' ||
    typeof (deliverTo as { toolCallId?: unknown }).toolCallId !== 'string'
  ) {
    return undefined;
  }
  return {
    delivery: deliverTo as DetachedDelivery,
    agent: typeof agentName === 'string' ? agentName : 'default',
  };
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
    // By token: this file ships in the `/durable` bundle, whose copy of the `ChatQueueService`
    // class is not the one `AgentModule` provides.
    @Optional() @Inject(AGENT_CHAT_QUEUE) private readonly queue?: ChatQueueService,
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

  async start(
    input: AgentRunInput,
    options: AgentRunStartOptions = {},
  ): Promise<{ runId: string }> {
    const stamped: AgentRunInput = { ...input, day: input.day ?? utcDay() };
    // Own the run id so we can still return it when the run suspends synchronously (below). A
    // caller-chosen id (a queued message's) makes the start idempotent: the runtime answers a start
    // under an id it already has with that run, instead of starting a second one.
    const runId = options.runId ?? randomUUID();
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

  /**
   * From the runtime's own run row. A run it does not know yet counts as running — a queued turn is
   * claimed before its `startChild` lands — and so does one it cannot be asked about: only a run the
   * runtime reports settled (`completed`/`failed`/`cancelled`/`dead`) is stale.
   */
  async isRunActive(runId: string): Promise<boolean> {
    try {
      const status = (await this.runs.getRunDetail(runId))?.run.status;
      return !(
        status === 'completed' ||
        status === 'failed' ||
        status === 'cancelled' ||
        status === 'dead'
      );
    } catch {
      return true;
    }
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
    const detail = await this.detailOf(runId);
    const input = detail?.run.input;
    const threadId = threadOfRun(input);
    await this.runs.cancel(runId, { compensate: true });
    await this.settleCancelledDelegation(runId, input);
    // The runtime cascades a Stop to every run this one SPAWNED. A detached delegation is no longer
    // started that way, but a turn that journaled its `spawn:` before it was still owns that child in
    // the runtime's eyes — and the cascade cancels it from outside, where nothing of ours runs.
    for (const childId of detail?.children ?? []) {
      await this.settleCascadedDetached(childId);
    }
    const writer = await this.sink.open(runId);
    if (threadId !== undefined) {
      // A thread's own turn hands the thread on first: an interrupt's message starts now, anything
      // else queued pauses behind the Stop. A sub-agent's run (it streams into another run's sink,
      // or delivers into another thread) has no queue of its own.
      if (this.queue?.supported === true && isThreadTurn(input)) {
        try {
          const frame = await this.queue.handoff(
            { threadId, runId, outcome: 'cancelled' },
            (next, nextRunId) => this.start(next, { runId: nextRunId }),
          );
          if (frame !== undefined) {
            await writer.write(encodeStreamEvent(frame));
          }
        } catch (error) {
          this.logger.error(
            `could not advance the queue of thread ${threadId} after cancelling ${runId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      await releaseThreadRun(this.store, threadId, runId);
    }
    await writer.write(encodeStreamEvent({ kind: 'cancelled' }));
    await writer.end();
    await this.store.recordRunEnd?.({ runId, status: 'cancelled' });
  }

  /**
   * Settle the delegation a DETACHED run was started for, once it has been stopped. A run parked on
   * a human never runs its body again — the runtime settles it from outside — so the body's own
   * `deliver:detached:unsettled` is not reached, and without this the card in the calling thread says
   * "started" for ever. Settles once (see `settleUnsettledDelegation`), so a body that did observe
   * the Stop and a run that had already answered are both left as they are. A no-op for any run
   * that does not deliver into another thread.
   */
  private async settleCancelledDelegation(runId: string, input: unknown): Promise<void> {
    const target = deliveryOf(input);
    if (target === undefined) {
      return;
    }
    try {
      await settleUnsettledDelegation({
        store: this.store,
        delivery: target.delivery,
        agent: target.agent,
        runId,
        status: 'cancelled',
      });
    } catch (error) {
      this.logger.error(
        `could not settle the delegation of cancelled run ${runId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * A detached child the runtime cancelled along with its parent (a `spawn:` journaled before
   * detached runs were started on their own): end it the way a Stop on its own id would have.
   */
  private async settleCascadedDetached(childId: string): Promise<void> {
    const child = await this.detailOf(childId);
    const status = child?.run.status;
    if (
      child === undefined ||
      deliveryOf(child.run.input) === undefined ||
      (status !== 'cancelled' && status !== 'cancelling')
    ) {
      return;
    }
    const subThreadId = threadOfRun(child.run.input);
    if (subThreadId !== undefined) {
      await releaseThreadRun(this.store, subThreadId, childId);
    }
    await this.settleCancelledDelegation(childId, child.run.input);
    const writer = await this.sink.open(childId);
    await writer.write(encodeStreamEvent({ kind: 'cancelled' }));
    await writer.end();
    await this.store.recordRunEnd?.({ runId: childId, status: 'cancelled' });
  }

  /**
   * What the runtime recorded for a run — the input it was started with (which thread it was streaming), its status and the runs it spawned — or `undefined` where the gateway cannot say.
   *
   * A read failure answers `undefined` instead of propagating, the same posture `AgentRunWorkflow`
   * takes for its own cancel observation: failing to ask is not an answer worth failing a cancel
   * over. This id is only needed to clear the thread's active stream, and a stream still marked live
   * is a far smaller fault than the one a throw here would cause — a run nobody ever told to stop,
   * with a subscriber holding a stream that never settles, from the one call whose entire job is to
   * make a run stop.
   */
  private async detailOf(runId: string): Promise<RunDetail | undefined> {
    try {
      return (await this.runs.getRunDetail(runId)) ?? undefined;
    } catch {
      return undefined;
    }
  }
}
