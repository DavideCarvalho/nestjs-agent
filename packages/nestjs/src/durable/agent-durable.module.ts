import { AGENT_DURABLE_RUNNER } from '@dudousxd/nestjs-agent-core';
import { Global, Module } from '@nestjs/common';
import { AgentRunWorkflow } from './agent-run.workflow.js';
import { DurableAgentRunner } from './durable-agent-runner.js';

/**
 * Opt-in durable runner. Import this alongside `AgentModule.forRoot({ durable: true })` and a
 * configured `DurableModule`. It registers the `agent.run` workflow (discovered by DurableModule)
 * and exposes the durable runner via `AGENT_DURABLE_RUNNER`, which AgentModule binds to
 * `AGENT_RUNNER`. Forgetting this import makes AgentModule throw a clear error at boot.
 */
@Global()
@Module({
  providers: [
    AgentRunWorkflow,
    DurableAgentRunner,
    { provide: AGENT_DURABLE_RUNNER, useExisting: DurableAgentRunner },
  ],
  exports: [AGENT_DURABLE_RUNNER, AgentRunWorkflow],
})
export class AgentDurableModule {}
