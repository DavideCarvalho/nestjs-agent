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
import { AgentRunWorkflow } from './agent-run.workflow.js';

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
  ) {}

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
   * and the subscriber gets a `cancelled` frame followed by a normal end. Both are keyed by runId
   * alone, which is why they belong here rather than in the body — the body is the only place that
   * knows which THREAD was streaming, so releasing that stays there (see `AgentRunWorkflow`).
   *
   * A tool already executing is not interrupted, here or anywhere: see `haltIfCancelled` in core.
   */
  async cancel(runId: string): Promise<void> {
    this.logger.log(`cancelling agent run ${runId}`);
    await this.runs.cancel(runId, { compensate: true });
    const writer = await this.sink.open(runId);
    await writer.write(encodeStreamEvent({ kind: 'cancelled' }));
    await writer.end();
    await this.store.recordRunEnd?.({ runId, status: 'cancelled' });
  }
}
