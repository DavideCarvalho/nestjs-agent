import type { AgentRunInput, AgentRunner, Decision } from '@dudousxd/nestjs-agent-core';
import { WorkflowService } from '@dudousxd/nestjs-durable';
import { Injectable } from '@nestjs/common';
import { utcDay } from '../agent-deps.js';
import { AgentRunWorkflow } from './agent-run.workflow.js';

/**
 * Runs the agent turn as a `@dudousxd/nestjs-durable` workflow. `start` enqueues and returns
 * the runId immediately; a worker runs the body and streams tokens to the sink. HITL approval
 * is delivered as a durable signal namespaced by run, so it can never cross-resolve another run.
 */
@Injectable()
export class DurableAgentRunner implements AgentRunner {
  constructor(private readonly workflows: WorkflowService) {}

  async start(input: AgentRunInput): Promise<{ runId: string }> {
    const stamped: AgentRunInput = { ...input, day: input.day ?? utcDay() };
    const result = await this.workflows.start(AgentRunWorkflow, stamped);
    return { runId: result.runId };
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
