import { AGENT_DEPS_FACTORY } from '@dudousxd/nestjs-agent-core';
import type { BufferedModelTurnResult } from '@dudousxd/nestjs-agent-core';
import { Step } from '@dudousxd/nestjs-durable';
import { Inject, Injectable } from '@nestjs/common';
import type { AgentDepsFactory } from '../agent-deps.factory.js';
import {
  type DispatchedLlmInput,
  type DispatchedToolInput,
  runLlmStep,
  runToolStep,
} from '../runner/agent-step-bodies.js';
import { outsideWorkflowCtx } from './outside-workflow-ctx.js';

export type { DispatchedLlmInput, DispatchedToolInput } from '../runner/agent-step-bodies.js';

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
  llm(input: DispatchedLlmInput): Promise<BufferedModelTurnResult> {
    return outsideWorkflowCtx(() => runLlmStep(this.factory, input));
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
  tool(input: DispatchedToolInput): Promise<unknown> {
    // A tool is the application's code: whatever it starts is a run of its own, never a position
    // in the agent run's journal (see `outsideWorkflowCtx`).
    return outsideWorkflowCtx(() => runToolStep(this.factory, input));
  }
}
