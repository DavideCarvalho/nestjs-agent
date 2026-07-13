import {
  AGENT_DURABLE_RUNNER,
  AGENT_OPTIONS,
  AGENT_SINK,
  type TokenStreamSink,
} from '@dudousxd/nestjs-agent-core';
import { type DynamicModule, Global, Logger, Module, type Provider } from '@nestjs/common';
import type { AgentModuleOptions, AgentSurface } from '../agent.options.js';
import { InProcessTokenStreamSink } from '../in-process-sink.js';
import { AgentRunSteps } from './agent-run.steps.js';
import { AgentRunWorkflow } from './agent-run.workflow.js';
import { AGENT_DISPATCHED_STEPS } from './dispatched-steps.token.js';
import { DurableAgentRunner } from './durable-agent-runner.js';

const logger = new Logger('AgentDurableModule');

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
  return [
    DurableAgentRunner,
    { provide: AGENT_DURABLE_RUNNER, useExisting: DurableAgentRunner },
    {
      provide: AGENT_DISPATCHED_STEPS,
      useFactory: (options: AgentModuleOptions, sink: TokenStreamSink) => {
        // Default ON under durable: dispatching moves the run off its pod during the two long
        // steps (the correct production posture) and AgentRunSteps is always registered on an
        // engine surface, so the routed groups are never unserved. `dispatchedSteps: false` opts
        // back into localSteps.
        const enabled = options.durable === true && options.dispatchedSteps !== false;
        // The default sink only buffers in-process: a dispatched `llm` step served by another
        // worker has no way to reach a buffer that lives in THIS process's memory. Detectable only
        // via `instanceof` (the sink SPI carries no "am I cross-process" capability) — good enough
        // for the built-in default, silent for any custom sink (which may well be cross-process).
        // Keyed off the EFFECTIVE value, so it fires for the durable default too — desired: the
        // cross-process-sink requirement is really a property of durable itself (any worker may
        // take agent.run), dispatch just widens how much of the turn runs elsewhere.
        if (enabled && sink instanceof InProcessTokenStreamSink) {
          logger.warn(
            'Dispatched steps are active (the default under durable: true) with the default ' +
              'InProcessTokenStreamSink, which only buffers tokens in-process. A dispatched `llm` ' +
              'step served by a different worker cannot stream into this buffer. Wire a ' +
              'cross-process TokenStreamSink (e.g. a Redis pub/sub sink) via ' +
              'AgentModule.forRoot({ sink }) before running multi-pod, or set ' +
              'dispatchedSteps: false to keep the turn in-process localSteps.',
          );
        }
        return enabled;
      },
      inject: [AGENT_OPTIONS, AGENT_SINK],
    },
  ];
}

/**
 * `surface: 'http'` wiring — the runner (so `AgentService.chat`/`.approve` and HITL signal delivery
 * all keep working) and the `agent.run` workflow (registered so `start()` succeeds — see
 * `AgentDurableModuleOptions.surface`), but NOT `AgentRunSteps`: this process must never subscribe
 * the dispatched-step queues. `AgentRunWorkflow`'s `AgentRunSteps` dependency is `@Optional()`
 * specifically so it can construct here without it (see that class's doc).
 */
@Global()
@Module({
  providers: [AgentRunWorkflow, ...runnerProviders()],
  exports: [AGENT_DURABLE_RUNNER, AgentRunWorkflow, AGENT_DISPATCHED_STEPS],
})
class AgentDurableHttpModule {}

/**
 * Opt-in durable runner. Import this alongside `AgentModule.forRoot({ durable: true })` and a
 * configured `DurableModule`. It registers the `agent.run` workflow (discovered by DurableModule)
 * and exposes the durable runner via `AGENT_DURABLE_RUNNER`, which AgentModule binds to
 * `AGENT_RUNNER`. Forgetting this import makes AgentModule throw a clear error at boot.
 *
 * Always provides `AgentRunSteps` regardless of `dispatchedSteps` — the worker group it serves
 * (`AgentRunSteps.llm`/`.tool`) must never be orphaned by a config flag the durable step registrar
 * can't see ahead of time. This is the FULL ('both'/'engine'-equivalent) wiring: bare-importing this
 * class (no `forRoot()` call) always gets it, unconditionally — `forRoot({ surface: 'http' })` is
 * the only form that diverges (see `AgentDurableHttpModule` above).
 */
@Global()
@Module({
  providers: [AgentRunWorkflow, AgentRunSteps, ...runnerProviders()],
  exports: [AGENT_DURABLE_RUNNER, AgentRunWorkflow, AgentRunSteps, AGENT_DISPATCHED_STEPS],
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
