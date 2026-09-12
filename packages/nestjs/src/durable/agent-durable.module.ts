import { AGENT_DURABLE_RUNNER } from '@dudousxd/nestjs-agent-core';
import { type DynamicModule, Global, Module, type Provider } from '@nestjs/common';
import type { AgentSurface } from '../agent.options.js';
import { AgentRunSteps } from './agent-run.steps.js';
import { AgentRunWorkflow } from './agent-run.workflow.js';
import { DurableAgentRunner } from './durable-agent-runner.js';

/**
 * `AgentDurableModule.forRoot()` options. `surface` mirrors `AgentModuleOptions.surface` — it has
 * to be its OWN option here (not read off the shared `AGENT_OPTIONS` provider) because Nest builds
 * a module's provider LIST at static/decoration time, before any DI value (including
 * `AGENT_OPTIONS`) exists to read; there is no way to make a `providers` array conditional on an
 * injected value. Keep both in sync — `agentDurable()` (`./agent-durable.js`) does this
 * automatically for the one-call setup; importing `AgentModule`/`AgentDurableModule` separately
 * means passing `surface` to both by hand.
 */
export interface AgentDurableModuleOptions {
  /**
   * Omit (or `'engine'`/`'both'`) for today's full wiring, unconditionally — identical to importing
   * the bare `AgentDurableModule` class (registers `agent.run` AND `AgentRunSteps.llm`/`.tool`).
   *
   * `'http'` registers the `agent.run` WORKFLOW (so `WorkflowService.start(AgentRunWorkflow, …)`
   * still works — `engine.start` requires local registration to validate/persist a new run, even
   * on an enqueue-only pod) but does NOT provide `AgentRunSteps` — the fix for the flip incident
   * this option exists for: an API pod that also registered the dispatched-step handlers
   * subscribed their queues and ran LLM/tool work meant for the worker fleet. Pair `surface: 'http'`
   * with the durable `DurableModule.forRoot({ drive: false })` enqueue-only config so this pod also
   * never DRIVES (polls/executes) the run it just registered — registration alone only satisfies
   * `start()`'s bookkeeping, it doesn't make this pod execute anything on its own.
   */
  surface?: AgentSurface;
}

/** Surface-invariant: the durable runner AgentModule binds `AGENT_RUNNER` to, needed under every `surface`. */
function runnerProviders(): Provider[] {
  return [DurableAgentRunner, { provide: AGENT_DURABLE_RUNNER, useExisting: DurableAgentRunner }];
}

/**
 * `surface: 'http'` wiring — the runner (so `AgentService.chat`/`.approve` and HITL signal delivery
 * all keep working) and the `agent.run` workflow (registered so `start()` succeeds — see
 * `AgentDurableModuleOptions.surface`), but NOT `AgentRunSteps`: this process must never subscribe
 * the dispatched-step queues. `AgentRunWorkflow` takes no `AgentRunSteps` dependency at all — it
 * routes by the `@Step`-stamped name off the prototype — so its body is the same here as on an
 * engine pod (see that class's doc).
 */
@Global()
@Module({
  providers: [AgentRunWorkflow, ...runnerProviders()],
  exports: [AGENT_DURABLE_RUNNER, AgentRunWorkflow],
})
class AgentDurableHttpModule {}

/**
 * Opt-in durable runner. Import this alongside `AgentModule.forRoot({ durable: true })` and a
 * configured `DurableModule`. It registers the `agent.run` workflow (discovered by DurableModule)
 * and exposes the durable runner via `AGENT_DURABLE_RUNNER`, which AgentModule binds to
 * `AGENT_RUNNER`. Forgetting this import makes AgentModule throw a clear error at boot.
 *
 * Provides `AgentRunSteps`, whose two groups (`AgentRunSteps.llm`/`.tool`) every turn dispatches to.
 * This is the FULL ('both'/'engine'-equivalent) wiring: bare-importing this class (no `forRoot()`
 * call) always gets it, unconditionally — `forRoot({ surface: 'http' })` is the only form that
 * diverges (see `AgentDurableHttpModule` above).
 */
@Global()
@Module({
  providers: [AgentRunWorkflow, AgentRunSteps, ...runnerProviders()],
  exports: [AGENT_DURABLE_RUNNER, AgentRunWorkflow, AgentRunSteps],
})
export class AgentDurableModule {
  /**
   * `surface: 'http'` returns the reduced `AgentDurableHttpModule` wiring (no `AgentRunSteps`);
   * everything else (omitted, `'engine'`, `'both'`) returns this module's own full wiring — the
   * class's `@Module` providers above merge in regardless of which DynamicModule shape a caller
   * imports (Nest merges a class's static provider list with whatever a self-referencing
   * `DynamicModule` adds), which is exactly why the reduced case has to be a DIFFERENT module class
   * rather than a conditional subset of this one's own decorator.
   */
  static forRoot(options?: AgentDurableModuleOptions): DynamicModule {
    if (options?.surface === 'http') {
      return { module: AgentDurableHttpModule, global: true };
    }
    return { module: AgentDurableModule, global: true };
  }
}
