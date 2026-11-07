import { AGENT_WORKFLOWS_RUNNER } from '@dudousxd/nestjs-agent-core';
import { Global, Module } from '@nestjs/common';
import { AgentRunFlow, AgentRunSegmentFlow } from './agent-run.flow.js';
import { AgentTurnExecutor } from './agent-turn.executor.js';
import { WorkflowsAgentRunner } from './workflows-agent-runner.js';

/**
 * Agent turns on NestJS's `@nestjs/workflows`. Import it next to `WorkflowsModule.forRoot()` and
 * `AgentModule.forRoot({ durable: true })`:
 *
 * ```ts
 * imports: [
 *   WorkflowsModule.forRoot(),
 *   AgentModule.forRoot({ model, store, durable: true }),
 *   AgentWorkflowsModule,
 * ]
 * ```
 *
 * It registers the `aviary.agent.run` workflow (and the one a long turn goes on in) and provides the
 * runner `AgentModule` binds `AGENT_RUNNER` to. Every process registers them, so any process can
 * start a turn; which processes RUN turns is `WorkflowsModule`'s `worker` option: on an API pod
 * that must not, `WorkflowsModule.forRoot({ worker: false })`.
 */
@Global()
@Module({
  providers: [
    AgentTurnExecutor,
    AgentRunFlow,
    AgentRunSegmentFlow,
    WorkflowsAgentRunner,
    { provide: AGENT_WORKFLOWS_RUNNER, useExisting: WorkflowsAgentRunner },
  ],
  exports: [AGENT_WORKFLOWS_RUNNER, WorkflowsAgentRunner],
})
export class AgentWorkflowsModule {}
