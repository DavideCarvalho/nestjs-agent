import {
  AGENT_DEPS_FACTORY,
  AGENT_STORE,
  type AgentLoopHooks,
  type AgentLoopResult,
  type AgentRunInput,
  type AgentStore,
  type Decision,
  type ElicitationReply,
  type LlmStepEnvelope,
  QuotaExceededError,
  RunCancelledError,
  type ToolCallRequest,
  type ToolStepEnvelope,
  agentFailureCode,
  isReplayIntegrityError,
  publishAgentRunFailed,
  runAgentLoop,
  settleAll,
  settleUnsettledDelegation,
} from '@dudousxd/nestjs-agent-core';
import { RUN_GATEWAY, Workflow } from '@dudousxd/nestjs-durable';
import {
  type RunGateway,
  type WorkflowCtx,
  isWorkflowControlFlowSignal,
} from '@dudousxd/nestjs-durable-core';
import { Inject, Injectable, Optional } from '@nestjs/common';
import type { AgentDepsFactory } from '../agent-deps.factory.js';
import { childSinkWriter, utcDay } from '../agent-deps.js';
import { AgentRunSteps } from './agent-run.steps.js';

/**
 * The agent turn AS a durable workflow. Persist/stream checkpoints are `ctx.localStep`s — the
 * in-process primitive, NOT the always-dispatched `ctx.step`: their names are dynamic checkpoint
 * identities (`persist:toolcall:<id>`), not routable worker groups, and their deps (store, sink)
 * live in THIS workflow worker's DI. The two LONG steps (model call, tool execution) are `ctx.step`s
 * routed to `AgentRunSteps`, so the run is never pinned to this pod while they execute — the same
 * thing `ctx.step` means anywhere in this ecosystem, and the reason a `@AiTool` handler must
 * establish whatever execution context it needs itself. HITL is `ctx.waitForSignal`, and sub-agent
 * delegation is `ctx.child(AgentRunWorkflow)` — a replay-safe, observable child run (it shows up as
 * a node in the durable dashboard). A child streams into its top-level ancestor's sink
 * (`sinkRunId`) so the human watching the parent sees it and can approve its action tools; the
 * approval routes to the child's own run via `runForToolCall`.
 */
@Injectable()
@Workflow({ name: 'agent.run', version: '1' })
export class AgentRunWorkflow {
  constructor(
    @Inject(AGENT_DEPS_FACTORY) private readonly factory: AgentDepsFactory,
    @Inject(AGENT_STORE) private readonly store: AgentStore,
    // NOTE: `AgentRunSteps` is deliberately NOT injected here, optionally or otherwise.
    // `AgentDurableModule.forRoot({ surface: 'http' })` registers this workflow (so
    // `WorkflowService.start` finds it locally — `engine.start` validates registration before
    // persisting a run, even on an enqueue-only pod) but provides no `AgentRunSteps`, because an
    // http pod that registered the dispatched-step handlers would subscribe their queues and run
    // LLM/tool work meant for the worker fleet. Depending on the instance here would make the
    // workflow BODY differ between the two surfaces, which is a replay divergence, not a
    // degradation — see `run()`.
    // The runtime's own view of this run, used for ONE question: has it been cancelled. `@Optional`
    // so a host that wired no gateway still boots — but note that the hook built from it is wired
    // UNCONDITIONALLY below. Its presence decides how many checkpoints a turn writes, and that must
    // not vary between two pods of the same deployment; only the ANSWER may degrade, and the answer
    // is journaled.
    @Optional() @Inject(RUN_GATEWAY) private readonly runs?: RunGateway,
  ) {}

  /**
   * Has someone asked this run to stop? Read from the runtime's own run status, which is where
   * `DurableAgentRunner.cancel` puts it — `cancelling` while a compensating cancel is in flight,
   * `cancelled` once it has settled.
   *
   * Costs a run read at each of the loop's observation points (two per step). That is a row the
   * control plane already has, against a turn that is otherwise making model calls, and it buys the
   * property that matters: the answer comes from a place BOTH the canceller and every pod that might
   * replay this run can see.
   *
   * Failing to ask is not a cancel. A tenant with no gateway wired, or an operator briefly
   * unreachable, answers "no" and the run carries on — the alternative is failing healthy runs
   * because a status read timed out. The loop journals that answer like any other, so two processes
   * can never disagree about what was seen here.
   */
  private async isCancelled(runId: string): Promise<boolean> {
    try {
      const status = (await this.runs?.getRunDetail(runId))?.run.status;
      return status === 'cancelled' || status === 'cancelling';
    } catch {
      return false;
    }
  }

  /**
   * Settle the delegation a DETACHED run was started for, when that run ends without an answer.
   *
   * The loop delivers its own success (`deliver:detached`) but cannot catch its own crash, and the
   * runtime settles the run row without knowing anything delegated it. Left alone, the card in the
   * calling conversation says "started" for ever — the one state a reader can neither wait on nor
   * act on. A no-op for every other run: only a detached one carries a delivery address.
   */
  private async settleDetachedParent(
    ctx: WorkflowCtx,
    input: AgentRunInput,
    outcome: { status: 'failed' | 'cancelled'; error?: string },
  ): Promise<void> {
    const delivery = input.deliverTo;
    if (delivery === undefined) {
      return;
    }
    await ctx.localStep('deliver:detached:unsettled', () =>
      settleUnsettledDelegation({
        store: this.store,
        delivery,
        agent: input.agentName ?? 'default',
        runId: ctx.runId,
        status: outcome.status,
        ...(outcome.error !== undefined ? { error: outcome.error } : {}),
      }),
    );
  }

  async run(ctx: WorkflowCtx, input: AgentRunInput): Promise<AgentLoopResult> {
    const day = input.day ?? utcDay();
    const deps = this.factory.forAgent(input.agentName);
    // A turn's model call and its tool executions are dispatched steps. The ONE thing that may say
    // otherwise is this run's own journal: a run recorded by a release that ran them in-process
    // wrote `llm:<i>`/`tool:<callId>` where the routed `AgentRunSteps.llm`/`.tool` groups now sit,
    // and it has to finish on the names it holds. `ctx.patched` answers that from the history and
    // nowhere else — it records the marker and returns true for a fresh run, and for a run whose
    // position already holds a real step it rewinds (spending no position) and returns false.
    //
    // Nothing process-local is read here, deliberately. `ctx.step` routes by the `@Step`-stamped
    // name off the prototype and never invokes the reference (the serving worker re-resolves the
    // real handler from its own DI), so a pod that provides no `AgentRunSteps` — `surface: 'http'`,
    // which registers this workflow only so `start()` can enqueue it — writes the same names an
    // engine pod does instead of degrading to the in-process ones and diverging from the history.
    const dispatchSteps = await ctx.patched('agent:dispatched-steps');
    // A sub-agent run marks its subthread as streaming THIS child run, so a human approving its
    // action tool routes the signal back here (runForToolCall) and a client may attach to its
    // stream. Both shapes of sub-agent qualify: one forwarding into an ancestor's sink, and a
    // DETACHED one, which has no ancestor sink and is recognized by its delivery address instead.
    if (input.sinkRunId !== undefined || input.deliverTo !== undefined) {
      await ctx.localStep('activate', () => this.store.setActiveStream(input.threadId, ctx.runId));
    }
    const sinkRunId = input.sinkRunId ?? ctx.runId;
    // The chain this run sits on, with its own agent appended — what lets a child recognise a
    // delegation back to an agent the chain has already passed through. Derived from the input, so
    // it is the same on every replay and on every pod.
    const chainBelow = [
      ...(input.delegationPath ?? []),
      ...(input.agentName !== undefined ? [input.agentName] : []),
    ];
    const hooks: AgentLoopHooks = {
      runId: ctx.runId,
      // A child forwards into the top-level sink but must not end/fail it (the top-level run owns it).
      openSink: async () =>
        input.sinkRunId !== undefined
          ? childSinkWriter(await deps.sink.open(sinkRunId))
          : deps.sink.open(ctx.runId),
      awaitApproval: (call) => ctx.waitForSignal<Decision>(`tool:${ctx.runId}:${call.id}`),
      // The same wait, on the same signal key, carrying a typed answer instead of a yes/no — so a
      // question set and an approval reach a parked run through one path, and the HTTP surface that
      // settles either one is the same `POST /agent/tool-call/*` family.
      awaitAnswers: (request) =>
        ctx.waitForSignal<ElicitationReply>(`tool:${ctx.runId}:${request.id}`),
      step: (name, fn) => ctx.localStep(name, fn),
      // Both durable step primitives take their checkpoint position on the CALL, before their first
      // await, so launching a batch in one tick — what `settleAll` does — fixes the block of
      // positions in call order however the tools then settle. `ctx.patched` keeps a run that
      // recorded the one-call-at-a-time shape replaying against that shape.
      parallel: settleAll,
      cancelled: () => this.isCancelled(ctx.runId),
      patched: (id) => ctx.patched(id),
      // Dispatched-step suspends must escape the loop's tool catch — control flow, not a tool
      // failure. Marker-based predicate, NOT instanceof: the signal's CLASS differs by runtime
      // (engine in-process throws durable-core's WorkflowSuspended/ContinueAsNew; the BullMQ thin
      // worker throws durable-worker's own Suspend), so only the Symbol.for marker is reliable.
      isControlFlowError: (error) => isWorkflowControlFlowSignal(error),
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
          delegationPath: chainBelow,
          parentRunId: ctx.runId,
          sinkRunId,
        });
      },
      // The same delegation, not awaited: `ctx.startChild` records a `spawn:<childRunId>` at this
      // position and returns, so THIS turn ends while the child is still working. Two things the
      // awaited form does are deliberately left off:
      //   - no `sinkRunId`. A detached run owns its own stream. Forwarding it into the turn that
      //     started it would write tokens, and a pending action-tool frame, into a stream whose
      //     reader has already seen `done` — and would put the child's approval card in whatever
      //     turn happened to be open. Its approval goes to the pending-approvals surface instead,
      //     which it reaches for free: the call is persisted `pending_approval` against the child's
      //     OWN runId, and that is what `runForToolCall` answers with.
      //   - `deliverTo` instead. The parent's tool result is a receipt, so the answer needs an
      //     address of its own, and by the time it exists nobody is holding one.
      startAgent: async ({ agentName, task, toolCallId }) => {
        const subThreadId = await ctx.localStep(`subthread:${agentName}`, async () => {
          const thread = await this.store.createThread({ actor: input.actor, transient: true });
          return thread.id;
        });
        const childRunId = await ctx.startChild(AgentRunWorkflow, {
          agentName,
          threadId: subThreadId,
          actor: input.actor,
          userText: task,
          day,
          delegationDepth: (input.delegationDepth ?? 0) + 1,
          delegationPath: chainBelow,
          parentRunId: ctx.runId,
          deliverTo: { threadId: input.threadId, toolCallId },
        });
        return { runId: childRunId };
      },
      // The two long steps as engine-dispatched `ctx.step`s, so a turn isn't pinned to this
      // workflow worker for the model call or a tool execution. `sinkRunId`/`childSink` are sink
      // routing this workflow already resolved above — core's dispatchLlm signature stays
      // sink-topology-agnostic, so we add them here, not in core. Omitted only for a run whose
      // journal predates dispatch (`dispatchSteps` above), which leaves the loop on `hooks.step`.
      ...(dispatchSteps
        ? {
            dispatchLlm: (index: number, envelope: LlmStepEnvelope) =>
              ctx.step(AgentRunSteps.prototype.llm, {
                ...envelope,
                runId: ctx.runId,
                step: index,
                sinkRunId,
                childSink: input.sinkRunId !== undefined,
              }),
            // Fold the call identity (`toolCallId`/`toolType`) into the wire payload — the handler
            // emits the `tool.execution` span with it. Only read/action calls reach dispatchTool
            // ('agent'-kind delegations branch to runAgent earlier in the loop), so anything that
            // isn't 'action' is defensively 'read' — the same posture core takes for an
            // unresolvable `kind`.
            dispatchTool: (call: ToolCallRequest, envelope: ToolStepEnvelope) =>
              ctx.step(AgentRunSteps.prototype.tool, {
                ...envelope,
                toolCallId: call.id,
                toolType: call.kind === 'action' ? 'action' : 'read',
              }),
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
      // Marker-based predicate, NOT instanceof: control-flow signals differ BY CLASS across the two
      // runtimes (the in-process engine throws durable-core's WorkflowSuspended/ContinueAsNew; the
      // BullMQ thin worker throws durable-worker's own Suspend). An instanceof check here
      // misclassified a thin-worker dispatch suspend as a real failure and ran the failure path
      // DURING the suspend — corrupting the run's history with extra checkpoints, so the resume
      // died with NondeterminismError. Only the Symbol.for marker is reliable cross-runtime (and
      // across duplicated module copies).
      if (isWorkflowControlFlowSignal(error)) {
        throw error;
      }
      // A cancel is neither a failure nor control flow — it is the run doing what it was asked. The
      // runner that requested it has already settled the run row and the subscriber's stream (both
      // keyed by runId alone). The thread is the one thing it could not reach, because only this
      // body knows which thread this run was streaming, so releasing it is all that is left here.
      // Nothing is published as a failure, and the error is rethrown so the runtime records the run
      // `cancelled` rather than completed.
      if (error instanceof RunCancelledError) {
        await ctx.localStep('deactivate', () => this.store.setActiveStream(input.threadId, null));
        await this.settleDetachedParent(ctx, input, { status: 'cancelled' });
        throw error;
      }
      // A replay-integrity failure gets the sink half of this path but NOT the checkpoint half. The
      // journal has already diverged, so the two `ctx.localStep`s below would each ask for a
      // position the history cannot supply and raise their own refusal — burying the one that names
      // the checkpoints that actually disagreed. The stream still has to be settled, though, or the
      // subscriber hangs on a run the engine is about to fail.
      if (isReplayIntegrityError(error)) {
        const failure = { code: 'run_failed' as const, message: (error as Error).message };
        publishAgentRunFailed({ runId: ctx.runId, ...failure });
        await (await hooks.openSink()).fail(failure);
        throw error;
      }
      // A real failure (e.g. quota exceeded, which throws before the sink is even opened) would
      // otherwise leave the HTTP subscriber hanging on a stream that never ends. Fail the sink with
      // a typed terminal so the controller emits an `event: error` frame, then rethrow so the engine
      // still records the run as failed.
      const message = error instanceof Error ? error.message : String(error);
      const code = agentFailureCode(error);
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
      await this.settleDetachedParent(ctx, input, { status: 'failed', error: message });
      // Reuse the run's own sink resolution: a top-level run fails the watched stream; a child run's
      // writer no-ops fail, deferring the surfaced error to the ancestor whose run also unwinds.
      const writer = await hooks.openSink();
      await writer.fail({ code, message });
      throw error;
    }
  }
}
