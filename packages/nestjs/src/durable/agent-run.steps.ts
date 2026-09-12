import {
  AGENT_DEPS_FACTORY,
  type AiToolCtx,
  type BufferedModelTurnResult,
  type LlmStepEnvelope,
  type SinkWriter,
  type ToolStepEnvelope,
  type ToolTransientRetrySetting,
  createFrameBuffer,
  invokeWithTransientRetry,
  publishAgentToolRetry,
  traceLlmTurn,
  traceToolExecution,
  withAskTool,
  withMemoryTool,
  withSkillTool,
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
 * The two long steps every turn dispatches as routed remote steps (`AgentRunSteps.llm` /
 * `AgentRunSteps.tool`). Both re-resolve their deps from THIS worker's own DI via
 * `AGENT_DEPS_FACTORY.forAgent` — a step can be served by any worker in the fleet, not just the one
 * that started the run, which is also why a host's `@AiTool` handler has to establish whatever
 * execution context it needs (a request-scoped ORM EntityManager, a CLS transaction) rather than
 * inherit one. Provided by `AgentDurableModule` under every surface but `'http'`, so the routed
 * groups are served wherever a run may be driven.
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
  async llm(input: DispatchedLlmInput): Promise<BufferedModelTurnResult> {
    const deps = this.factory.forAgent(input.agentName);
    // The envelope carries only wire-safe data — a `ToolDefinition` holds a live Zod/StandardSchema
    // instance that can't survive JSON transport, so this handler re-derives it from `input.actor`,
    // exactly like the loop's own non-dispatched branch does.
    // `withAskTool` from THIS worker's own resolved deps, not from the envelope: `ask` is module
    // config, uniform across a deployment, so the worker reaches the same list the loop would have
    // built locally without the wire contract having to carry the flag.
    // `withSkillTool` for the same reason as `withAskTool` below it: both are module config,
    // uniform across a deployment, so this worker reaches the same tool list the loop would have
    // built without the wire contract having to carry either flag. WHICH skills the model may load
    // is a different question, and it is answered by the catalog in the prompt this envelope
    // carries — never by this worker's own provider.
    // `withMemoryTool` on the same footing, and for the same reason: whether this deployment offers
    // `remember` is module config. WHICH memories the model was shown is a different question, and
    // it is answered by the block in the prompt this envelope carries — never by this worker's own
    // provider.
    const tools = withMemoryTool({
      tools: withSkillTool({
        tools: withAskTool({
          tools: await deps.registry.definitionsFor(
            input.actor,
            deps.rolesPolicy,
            deps.toolAllowList,
          ),
          ask: deps.ask,
        }),
        enabled: deps.skills !== undefined,
      }),
      enabled: deps.memory?.provider.write !== undefined,
    });
    // `bufferOutput` means the dispatching loop has an output gate to run and this worker's sink is
    // on the far side of it: streaming here would put the answer in front of the reader before the
    // gate ever saw it. Hold the frames and hand them back on the result — the loop releases them
    // (or does not) from the checkpoint that carries the verdict. A durable retry of this step
    // simply re-buffers, so no half-gated turn can reach the sink.
    const buffer = input.bufferOutput === true ? createFrameBuffer() : undefined;
    let writer: SinkWriter;
    if (buffer !== undefined) {
      writer = buffer.writer;
    } else {
      const opened = await deps.sink.open(input.sinkRunId);
      writer = input.childSink ? childSinkWriter(opened) : opened;
    }
    // Span-wrapped HERE (the genuine execution site), emitting the identical `aviary:agent:llm.turn`
    // span core's non-dispatched branch emits — from whichever worker actually serves the step.
    // Replay-safe by construction: a dispatched step's handler only runs on genuine dispatch (replay
    // resolves the step from its checkpoint without re-invoking a worker), which is exactly why core
    // exports the helper instead of wrapping the `hooks.dispatchLlm` CALL site itself.
    const turn = await traceLlmTurn(input.runId, input.step, () =>
      deps.model.runTurn({
        system: input.system,
        messages: input.messages,
        tools,
        sink: writer,
      }),
    );
    return buffer === undefined ? turn : { ...turn, bufferedFrames: buffer.frames() };
  }

  /**
   * NO DURABLE retries — a tool may not be idempotent (a bare `@Step()` carries none, unlike `llm`
   * above). What it does retry, in place, is a CLASSIFIED-TRANSIENT error from the tool's own
   * invocation (a DB deadlock, a lock-wait timeout — see `isTransientToolError`): the server rolled
   * that work back, so re-invoking it is safe, and doing it here (inside this one step, never a new
   * checkpoint) is exactly how the non-dispatched loop path handles it too. The timeout is applied
   * HERE, handler-side, via `withToolTimeout` — never as a durable dispatch `timeoutMs`, which
   * bounds engine liveness (retryable) rather than the tool's own business outcome — and per
   * ATTEMPT, so a retried invocation gets its own fresh timeout window.
   */
  @Step()
  async tool(input: DispatchedToolInput): Promise<unknown> {
    const deps = this.factory.forAgent(input.ctx.agentName);
    // The approval gate lives in the LOOP, which resolved this call's kind from the registry of the
    // process that ran the body. This worker has its own registry, and it is the process that
    // actually runs the tool — so if it knows the tool as an `action` while the envelope says the
    // loop auto-executed it, the loop resolved the kind against a registry that was missing it, and
    // running the tool here would perform an approved-only action nobody approved. Refuse: the loop
    // reports it as a tool failure the model can answer for, which is recoverable, unlike the side
    // effect.
    if (deps.registry.spec(input.toolName)?.kind === 'action' && input.toolType !== 'action') {
      throw new Error(
        `tool "${input.toolName}" is an action tool but was dispatched without approval: the dispatching process resolved its kind against a registry that does not have it`,
      );
    }
    // AgentDeps carries no `host` today (AgentDepsFactory never populates one), so the rebuilt ctx
    // is exactly `input.ctx` — no narrower than what the non-dispatched path already threads through.
    const ctx: AiToolCtx = { ...input.ctx };
    // The envelope carries the numeric half (attempts/backoffMs) the dispatching loop already
    // resolved — the SAME policy as the non-dispatched path. `classify` isn't wire-safe, so it's
    // resolved from THIS worker's own local module options instead (same DI re-resolution as
    // `registry`/`rolesPolicy` above) — a custom classifier applies host-side in both processes.
    const localClassify =
      deps.toolTransientRetry !== false ? deps.toolTransientRetry?.classify : undefined;
    const transientRetry: ToolTransientRetrySetting =
      input.transientRetry === false
        ? false
        : {
            attempts: input.transientRetry.attempts,
            backoffMs: input.transientRetry.backoffMs,
            ...(localClassify !== undefined ? { classify: localClassify } : {}),
          };
    // Span-wrapped HERE like `llm` above (same replay-safety-by-construction reasoning) — the
    // timeout AND the retry loop sit INSIDE the span so every attempt (and a timed-out attempt)
    // surfaces under the span's error phase.
    return traceToolExecution(
      input.ctx.runId,
      { toolCallId: input.toolCallId, toolName: input.toolName, toolType: input.toolType },
      () =>
        invokeWithTransientRetry(
          () => {
            const invocation = deps.registry.invoke(
              input.toolName,
              input.input,
              ctx,
              deps.rolesPolicy,
            );
            return input.timeoutMs !== undefined
              ? withToolTimeout(invocation, input.timeoutMs, input.toolName)
              : invocation;
          },
          transientRetry,
          {
            onRetry: (attempt, error) => {
              publishAgentToolRetry({
                toolName: input.toolName,
                toolCallId: input.toolCallId,
                attempt,
                message: error instanceof Error ? error.message : String(error),
              });
            },
          },
        ),
    );
  }
}
