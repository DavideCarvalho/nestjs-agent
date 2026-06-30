import {
  AGENT_DEPS_FACTORY,
  AGENT_STORE,
  type AgentLoopHooks,
  type AgentRunInput,
  type AgentStore,
  type Decision,
  runAgentLoop,
} from '@dudousxd/nestjs-agent-core';
import { Workflow } from '@dudousxd/nestjs-durable';
import type { WorkflowCtx } from '@dudousxd/nestjs-durable-core';
import { Inject, Injectable } from '@nestjs/common';
import { utcDay } from '../agent-deps.js';
import type { AgentDepsFactory } from '../agent-deps.factory.js';

/**
 * The agent turn AS a durable workflow. Each model/tool call is a checkpointed `ctx.step`, HITL is
 * `ctx.waitForSignal`, and sub-agent delegation is `ctx.child(AgentRunWorkflow)` — a replay-safe,
 * observable child run (it shows up as a node in the durable dashboard).
 */
@Injectable()
@Workflow({ name: 'agent.run', version: '1' })
export class AgentRunWorkflow {
  constructor(
    @Inject(AGENT_DEPS_FACTORY) private readonly factory: AgentDepsFactory,
    @Inject(AGENT_STORE) private readonly store: AgentStore,
  ) {}

  async run(ctx: WorkflowCtx, input: AgentRunInput): Promise<{ text: string }> {
    const day = input.day ?? utcDay();
    const deps = this.factory.forAgent(input.agentName);
    const hooks: AgentLoopHooks = {
      runId: ctx.runId,
      openSink: () => deps.sink.open(ctx.runId),
      awaitApproval: (call) => ctx.waitForSignal<Decision>(`tool:${ctx.runId}:${call.id}`),
      step: (name, fn) => ctx.step(name, fn),
      runAgent: async (agentName, task) => {
        const subThreadId = await ctx.step(`subthread:${agentName}`, async () => {
          const thread = await this.store.createThread({
            actor: input.actor,
            persona: 'default',
            transient: true,
          });
          return thread.id;
        });
        return ctx.child(AgentRunWorkflow, {
          agentName,
          threadId: subThreadId,
          actor: input.actor,
          userText: task,
          day,
        });
      },
    };
    return runAgentLoop({ ...deps, day }, input, hooks);
  }
}
