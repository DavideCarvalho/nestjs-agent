import {
  AGENT_DEPS_FACTORY,
  type AiToolCtx,
  type LlmStepEnvelope,
  type ModelTurnResult,
  type ToolStepEnvelope,
  traceLlmTurn,
  traceToolExecution,
  withToolTimeout,
} from '@dudousxd/nestjs-agent-core';
import { Step } from '@dudousxd/nestjs-durable';
import { Inject, Injectable } from '@nestjs/common';
import type { AgentDepsFactory } from '../agent-deps.factory.js';
import { childSinkWriter } from '../agent-deps.js';

/**
 * Serializable input for the dispatched `llm` step: a {@link LlmStepEnvelope} plus the sink routing
 * only the durable runner knows (`sinkRunId`/`childSink`) — core's `AgentLoopHooks.dispatchLlm` stays
 * sink-topology-agnostic, so the workflow adds these two fields when it builds the envelope.
 */
export interface DispatchedLlmInput extends LlmStepEnvelope {
  /**
   * The dispatching workflow's own `ctx.runId` — the run this step's outcome accrues to for
   * reliability metrics (`bumpRunRetries`). Carried even though the handler cannot bump retries
   * today: the durable handler boundary (`runStepHandler`) hands a `@Step` method only
   * `(input, StepLogger)` — the wire task's `attempt` is not exposed — so there is no clean way to
   * detect a retry from inside the handler. Kept on the envelope so the bump can be wired without a
   * wire-contract change once the durable runtime exposes the attempt.
   */
  runId: string;
  /** The turn index within the run (`llm:<step>`) — the `llm.turn` span's `step` metadata. */
  step: number;
  /** The stream target: `input.sinkRunId ?? ctx.runId` of the dispatching workflow. */
  sinkRunId: string;
  /** True for a sub-agent run — wrap the writer with {@link childSinkWriter} (no end/fail). */
  childSink: boolean;
}

/**
 * Serializable input for the dispatched `tool` step: a {@link ToolStepEnvelope} plus the call
 * identity the `tool.execution` span needs (`toolCallId`/`toolType`) — core's
 * `AgentLoopHooks.dispatchTool` passes those on the separate `ToolCallRequest` argument, so the
 * workflow folds them into the wire payload when it dispatches (same pattern as
 * {@link DispatchedLlmInput}'s sink routing).
 */
export interface DispatchedToolInput extends ToolStepEnvelope {
  toolCallId: string;
  toolType: 'read' | 'action';
}

/**
 * The two long steps `AgentRunWorkflow` dispatches as routed remote steps (`AgentRunSteps.llm` /
 * `AgentRunSteps.tool`) — the default under `durable: true`; `dispatchedSteps: false` runs them
 * in-process under `ctx.localStep` instead. Both re-resolve their deps from THIS worker's own DI via
 * `AGENT_DEPS_FACTORY.forAgent` — a step can be served by any worker in the fleet, not just the one
 * that started the run. Always provided by `AgentDurableModule` regardless of `dispatchedSteps`, so
 * the worker group is never orphaned.
 */
@Injectable()
export class AgentRunSteps {
  constructor(@Inject(AGENT_DEPS_FACTORY) private readonly factory: AgentDepsFactory) {}

  /**
   * Retryable: every side effect (persist/quota/stream markers) happens loop-side under
   * `hooks.step`, so a durable retry only re-runs the model call and re-streams its tokens — never
   * double-writes. NEVER call `writer.end()`/`fail()` here: the workflow owns the stream's lifecycle,
   * across however many turns/retries it takes.
   */
  @Step({ retries: 3 })
  async llm(input: DispatchedLlmInput): Promise<ModelTurnResult> {
    const deps = this.factory.forAgent(input.agentName);
    // The envelope carries only wire-safe data — a `ToolDefinition` holds a live Zod/StandardSchema
    // instance that can't survive JSON transport, so this handler re-derives it from `input.actor`,
    // exactly like the loop's own non-dispatched branch does.
    const tools = await deps.registry.definitionsFor(
      input.actor,
      deps.rolesPolicy,
      deps.toolAllowList,
    );
    const opened = await deps.sink.open(input.sinkRunId);
    const writer = input.childSink ? childSinkWriter(opened) : opened;
    // Span-wrapped HERE (the genuine execution site), emitting the identical `aviary:agent:llm.turn`
    // span core's non-dispatched branch emits — from whichever worker actually serves the step.
    // Replay-safe by construction: a dispatched step's handler only runs on genuine dispatch (replay
    // resolves the step from its checkpoint without re-invoking a worker), which is exactly why core
    // exports the helper instead of wrapping the `hooks.dispatchLlm` CALL site itself.
    return traceLlmTurn(input.runId, input.step, () =>
      deps.model.runTurn({
        system: input.system,
        messages: input.messages,
        tools,
        sink: writer,
      }),
    );
  }

  /**
   * No retries — a tool may not be idempotent (a bare `@Step()` carries none, unlike `llm` above).
   * The timeout is applied HERE, handler-side, via `withToolTimeout` — never as a durable dispatch
   * `timeoutMs`, which bounds engine liveness (retryable) rather than the tool's own business outcome.
   */
  @Step()
  async tool(input: DispatchedToolInput): Promise<unknown> {
    const deps = this.factory.forAgent(input.ctx.agentName);
    // AgentDeps carries no `host` today (AgentDepsFactory never populates one), so the rebuilt ctx
    // is exactly `input.ctx` — no narrower than what the non-dispatched path already threads through.
    const ctx: AiToolCtx = { ...input.ctx };
    // Span-wrapped HERE like `llm` above (same replay-safety-by-construction reasoning) — the
    // timeout sits INSIDE the span so a timed-out tool surfaces as the span's error phase.
    return traceToolExecution(
      input.ctx.runId,
      { toolCallId: input.toolCallId, toolName: input.toolName, toolType: input.toolType },
      () => {
        const invocation = deps.registry.invoke(input.toolName, input.input, ctx, deps.rolesPolicy);
        return input.timeoutMs !== undefined
          ? withToolTimeout(invocation, input.timeoutMs, input.toolName)
          : invocation;
      },
    );
  }
}
