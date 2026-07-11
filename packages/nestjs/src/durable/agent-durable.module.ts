import {
  AGENT_DURABLE_RUNNER,
  AGENT_OPTIONS,
  AGENT_SINK,
  type TokenStreamSink,
} from '@dudousxd/nestjs-agent-core';
import { type DynamicModule, Global, Logger, Module } from '@nestjs/common';
import type { AgentModuleOptions } from '../agent.options.js';
import { InProcessTokenStreamSink } from '../in-process-sink.js';
import { AgentRunSteps } from './agent-run.steps.js';
import { AgentRunWorkflow } from './agent-run.workflow.js';
import { AGENT_DISPATCHED_STEPS } from './dispatched-steps.token.js';
import { DurableAgentRunner } from './durable-agent-runner.js';

const logger = new Logger('AgentDurableModule');

/**
 * Opt-in durable runner. Import this alongside `AgentModule.forRoot({ durable: true })` and a
 * configured `DurableModule`. It registers the `agent.run` workflow (discovered by DurableModule)
 * and exposes the durable runner via `AGENT_DURABLE_RUNNER`, which AgentModule binds to
 * `AGENT_RUNNER`. Forgetting this import makes AgentModule throw a clear error at boot.
 *
 * Always provides `AgentRunSteps` regardless of `dispatchedSteps` — the worker group it serves
 * (`AgentRunSteps.llm`/`.tool`) must never be orphaned by a config flag the durable step registrar
 * can't see ahead of time.
 */
@Global()
@Module({
  providers: [
    AgentRunWorkflow,
    AgentRunSteps,
    DurableAgentRunner,
    { provide: AGENT_DURABLE_RUNNER, useExisting: DurableAgentRunner },
    {
      provide: AGENT_DISPATCHED_STEPS,
      useFactory: (options: AgentModuleOptions, sink: TokenStreamSink) => {
        const enabled = options.dispatchedSteps ?? false;
        // The default sink only buffers in-process: a dispatched `llm` step served by another
        // worker has no way to reach a buffer that lives in THIS process's memory. Detectable only
        // via `instanceof` (the sink SPI carries no "am I cross-process" capability) — good enough
        // for the built-in default, silent for any custom sink (which may well be cross-process).
        if (enabled && sink instanceof InProcessTokenStreamSink) {
          logger.warn(
            'dispatchedSteps is enabled with the default InProcessTokenStreamSink, which only ' +
              'buffers tokens in-process. A dispatched `llm` step served by a different worker ' +
              'cannot stream into this buffer. Wire a cross-process TokenStreamSink (e.g. a Redis ' +
              'pub/sub sink) via AgentModule.forRoot({ sink }) before running multi-pod.',
          );
        }
        return enabled;
      },
      inject: [AGENT_OPTIONS, AGENT_SINK],
    },
  ],
  exports: [AGENT_DURABLE_RUNNER, AgentRunWorkflow, AgentRunSteps, AGENT_DISPATCHED_STEPS],
})
export class AgentDurableModule {
  /**
   * The dynamic form used by the `agentDurable` helper. The module needs no configuration of its
   * own (its providers come from the decorator above), so this just yields the module reference —
   * importing `AgentDurableModule` directly stays equivalent.
   */
  static forRoot(): DynamicModule {
    return { module: AgentDurableModule, global: true };
  }
}
