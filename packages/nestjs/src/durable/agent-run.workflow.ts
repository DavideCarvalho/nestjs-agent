import {
  type AgentLoopHooks,
  type AgentRunInput,
  type Decision,
  runAgentLoop,
} from '@dudousxd/nestjs-agent-core';
import { Workflow } from '@dudousxd/nestjs-durable';
import type { WorkflowCtx } from '@dudousxd/nestjs-durable-core';
import { Inject, Injectable } from '@nestjs/common';
import { AGENT_DEPS, type AgentDeps, utcDay } from '../agent-deps.js';

/**
 * The agent turn AS a durable workflow. Each model/tool call is a checkpointed `ctx.step`,
 * so a crash mid-turn replays from cache; HITL is `ctx.waitForSignal`, so the run suspends
 * durably while waiting for approval instead of holding a connection.
 */
@Injectable()
@Workflow({ name: 'agent.run', version: '1' })
export class AgentRunWorkflow {
  constructor(@Inject(AGENT_DEPS) private readonly deps: AgentDeps) {}

  async run(ctx: WorkflowCtx, input: AgentRunInput): Promise<{ text: string }> {
    const hooks: AgentLoopHooks = {
      runId: ctx.runId,
      openSink: () => this.deps.sink.open(ctx.runId),
      awaitApproval: (call) => ctx.waitForSignal<Decision>(`tool:${ctx.runId}:${call.id}`),
      step: (name, fn) => ctx.step(name, fn),
    };
    return runAgentLoop({ ...this.deps, day: input.day ?? utcDay() }, input, hooks);
  }
}
