import {
  AGENT_DEPS_FACTORY,
  AGENT_STORE,
  type AgentLoopHooks,
  type AgentRunInput,
  type AgentStore,
  type Decision,
  QuotaExceededError,
  publishAgentRunFailed,
  runAgentLoop,
} from '@dudousxd/nestjs-agent-core';
import { Workflow } from '@dudousxd/nestjs-durable';
import { ContinueAsNew, type WorkflowCtx, WorkflowSuspended } from '@dudousxd/nestjs-durable-core';
import { Inject, Injectable } from '@nestjs/common';
import type { AgentDepsFactory } from '../agent-deps.factory.js';
import { utcDay } from '../agent-deps.js';

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
          delegationDepth: (input.delegationDepth ?? 0) + 1,
        });
      },
    };
    try {
      return await runAgentLoop({ ...deps, day }, input, hooks);
    } catch (error) {
      // A suspend / continue-as-new is control flow, not a failure — let the engine handle it.
      if (error instanceof WorkflowSuspended || error instanceof ContinueAsNew) {
        throw error;
      }
      // A real failure (e.g. quota exceeded, which throws before the sink is even opened) would
      // otherwise leave the HTTP subscriber hanging on a stream that never ends. Fail the sink with
      // a typed terminal so the controller emits an `event: error` frame, then rethrow so the engine
      // still records the run as failed.
      const message = error instanceof Error ? error.message : String(error);
      const code = error instanceof QuotaExceededError ? 'quota_exceeded' : 'run_failed';
      publishAgentRunFailed({ runId: ctx.runId, code, message });
      const writer = await deps.sink.open(ctx.runId);
      await writer.fail({ code, message });
      throw error;
    }
  }
}
