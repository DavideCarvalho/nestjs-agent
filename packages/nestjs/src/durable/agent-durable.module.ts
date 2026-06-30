import { AGENT_RUNNER } from '@dudousxd/nestjs-agent-core';
import { Global, Module } from '@nestjs/common';
import { AgentRunWorkflow } from './agent-run.workflow.js';
import { DurableAgentRunner } from './durable-agent-runner.js';

/**
 * Opt-in durable runner. Import this alongside `AgentModule.forRoot({ durable: true })` and a
 * configured `DurableModule`. It registers the `agent.run` workflow (discovered by DurableModule)
 * and rebinds `AGENT_RUNNER` to the durable implementation.
 */
@Global()
@Module({
  providers: [
    AgentRunWorkflow,
    DurableAgentRunner,
    { provide: AGENT_RUNNER, useExisting: DurableAgentRunner },
  ],
  exports: [AGENT_RUNNER, AgentRunWorkflow],
})
export class AgentDurableModule {}
