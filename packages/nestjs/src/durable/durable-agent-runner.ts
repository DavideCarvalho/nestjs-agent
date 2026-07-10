import { randomUUID } from 'node:crypto';
import type { AgentRunInput, AgentRunner, Decision } from '@dudousxd/nestjs-agent-core';
import { WorkflowService } from '@dudousxd/nestjs-durable';
import { WorkflowSuspended } from '@dudousxd/nestjs-durable-core';
import { Injectable } from '@nestjs/common';
import { utcDay } from '../agent-deps.js';
import { AgentRunWorkflow } from './agent-run.workflow.js';

/**
 * Runs the agent turn as a `@dudousxd/nestjs-durable` workflow. `start` creates the run and returns
 * its id immediately; a worker runs the body and streams tokens to the sink. HITL approval is
 * delivered as a durable signal namespaced by run, so it can never cross-resolve another run.
 */
@Injectable()
export class DurableAgentRunner implements AgentRunner {
  constructor(private readonly workflows: WorkflowService) {}

  async start(input: AgentRunInput): Promise<{ runId: string }> {
    const stamped: AgentRunInput = { ...input, day: input.day ?? utcDay() };
    // Own the run id so we can still return it when the run suspends synchronously (below).
    const runId = randomUUID();
    try {
      await this.workflows.start(AgentRunWorkflow, stamped, runId);
    } catch (error) {
      // A run that suspends on its FIRST step (waiting on the model/tool worker, a signal, or a
      // sleep) surfaces the engine's internal `WorkflowSuspended` signal here whenever the start ran
      // under a DRIVING dispatcher (e.g. a durable tenant/worker) rather than the enqueue-only one.
      // That is expected control flow, NOT a failure: the run is already persisted and a worker will
      // resume it, while the caller streams the sink meanwhile. Swallow it and return the run id;
      // any other error is a real start failure and propagates.
      if (!(error instanceof WorkflowSuspended)) {
        throw error;
      }
    }
    return { runId };
  }

  async signal(runId: string, toolCallId: string, decision: Decision): Promise<void> {
    await this.workflows.signal(`tool:${runId}:${toolCallId}`, decision);
  }

  async cancel(_runId: string): Promise<void> {
    // WorkflowService exposes no hard cancel; rely on the execution timeout / control plane.
    // Apps needing immediate cancel can resolve WorkflowEngine and call engine.cancel(runId).
    await Promise.resolve();
  }
}
