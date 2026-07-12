import {
  AGENT_DEPS_FACTORY,
  AGENT_STORE,
  type AgentLoopHooks,
  type AgentRunInput,
  type AgentStore,
  type Decision,
  type LlmStepEnvelope,
  QuotaExceededError,
  type ToolCallRequest,
  type ToolStepEnvelope,
  publishAgentRunFailed,
  runAgentLoop,
} from '@dudousxd/nestjs-agent-core';
import { Workflow } from '@dudousxd/nestjs-durable';
import { ContinueAsNew, type WorkflowCtx, WorkflowSuspended } from '@dudousxd/nestjs-durable-core';
import { Inject, Injectable } from '@nestjs/common';
import type { AgentDepsFactory } from '../agent-deps.factory.js';
import { childSinkWriter, utcDay } from '../agent-deps.js';
import { AgentRunSteps } from './agent-run.steps.js';
import { AGENT_DISPATCHED_STEPS } from './dispatched-steps.token.js';

/**
 * The agent turn AS a durable workflow. Persist/stream checkpoints are `ctx.localStep`s — the
 * in-process primitive, NOT the always-dispatched `ctx.step`: their names are dynamic checkpoint
 * identities (`persist:toolcall:<id>`), not routable worker groups, and their deps (store, sink)
 * live in THIS workflow worker's DI. The two LONG steps (model call, tool execution) are dispatched
 * through `AgentRunSteps` by default (`AGENT_DISPATCHED_STEPS`, ON under `durable: true`) so the
 * run isn't pinned to this pod while they execute; `dispatchedSteps: false` keeps them localSteps
 * too. HITL is `ctx.waitForSignal`, and sub-agent delegation is `ctx.child(AgentRunWorkflow)` — a
 * replay-safe, observable child run (it shows up as a node in the durable dashboard). A child
 * streams into its top-level ancestor's sink (`sinkRunId`) so the human watching the parent sees it
 * and can approve its action tools; the approval routes to the child's own run via `runForToolCall`.
 */
@Injectable()
@Workflow({ name: 'agent.run', version: '1' })
export class AgentRunWorkflow {
  constructor(
    @Inject(AGENT_DEPS_FACTORY) private readonly factory: AgentDepsFactory,
    @Inject(AGENT_STORE) private readonly store: AgentStore,
    private readonly steps: AgentRunSteps,
    @Inject(AGENT_DISPATCHED_STEPS) private readonly dispatchedSteps: boolean,
  ) {}

  async run(ctx: WorkflowCtx, input: AgentRunInput): Promise<{ text: string }> {
    const day = input.day ?? utcDay();
    const deps = this.factory.forAgent(input.agentName);
    // A sub-agent run (one with an ancestor sink) marks its subthread as streaming THIS child run,
    // so a human approving its action tool routes the signal back here (runForToolCall).
    if (input.sinkRunId !== undefined) {
      await ctx.localStep('activate', () => this.store.setActiveStream(input.threadId, ctx.runId));
    }
    const sinkRunId = input.sinkRunId ?? ctx.runId;
    const hooks: AgentLoopHooks = {
      runId: ctx.runId,
      // A child forwards into the top-level sink but must not end/fail it (the top-level run owns it).
      openSink: async () =>
        input.sinkRunId !== undefined
          ? childSinkWriter(await deps.sink.open(sinkRunId))
          : deps.sink.open(ctx.runId),
      awaitApproval: (call) => ctx.waitForSignal<Decision>(`tool:${ctx.runId}:${call.id}`),
      step: (name, fn) => ctx.localStep(name, fn),
      // Dispatched-step suspends must escape the loop's tool catch — control flow, not a tool failure.
      isControlFlowError: (error) =>
        error instanceof WorkflowSuspended || error instanceof ContinueAsNew,
      runAgent: async (agentName, task) => {
        const subThreadId = await ctx.localStep(`subthread:${agentName}`, async () => {
          const thread = await this.store.createThread({
            actor: input.actor,
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
          sinkRunId,
        });
      },
      // Routes the two long steps through AgentRunSteps as engine-dispatched `ctx.step`s instead of
      // `ctx.localStep`s, so a turn isn't pinned to this workflow worker for the model call or a tool
      // execution. `sinkRunId`/`childSink` are sink routing this workflow already resolved above —
      // core's dispatchLlm signature stays sink-topology-agnostic, so we add them here, not in core.
      ...(this.dispatchedSteps
        ? {
            dispatchLlm: (_index: number, envelope: LlmStepEnvelope) =>
              ctx.step(this.steps.llm, {
                ...envelope,
                runId: ctx.runId,
                sinkRunId,
                childSink: input.sinkRunId !== undefined,
              }),
            dispatchTool: (_call: ToolCallRequest, envelope: ToolStepEnvelope) =>
              ctx.step(this.steps.tool, envelope),
          }
        : {}),
    };
    try {
      const result = await runAgentLoop({ ...deps, day }, input, hooks);
      // Genuine completion (not a suspend) — clear so `activeRunForThread` no longer reports this
      // run. `input.threadId` is whichever thread this run's own `activate`/the top-level `chat()`
      // call marked active, so this is correct for both a top-level run and a sub-agent's subthread.
      await ctx.localStep('deactivate', () => this.store.setActiveStream(input.threadId, null));
      return result;
    } catch (error) {
      // A suspend / continue-as-new is control flow, not a failure — let the engine handle it. The
      // thread stays "active" across the suspend, which is correct: the turn hasn't finished.
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
      // Settle the run's persisted outcome (the loop only records completions — it can't catch its
      // own crash). Optional-call: a store without run recording degrades to no reliability metrics.
      await ctx.localStep(
        'persist:run:fail',
        () =>
          this.store.recordRunEnd?.({
            runId: ctx.runId,
            status: 'failed',
            errorCode: code,
            errorMessage: message,
          }) ?? Promise.resolve(),
      );
      await ctx.localStep('deactivate', () => this.store.setActiveStream(input.threadId, null));
      // Reuse the run's own sink resolution: a top-level run fails the watched stream; a child run's
      // writer no-ops fail, deferring the surfaced error to the ancestor whose run also unwinds.
      const writer = await hooks.openSink();
      await writer.fail({ code, message });
      throw error;
    }
  }
}
