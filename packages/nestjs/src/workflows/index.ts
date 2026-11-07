/**
 * `@dudousxd/nestjs-agent/workflows`: agent turns on NestJS's `@nestjs/workflows`, the engine
 * `AgentModule.forRoot({ durable: true })` runs on.
 */
export { AgentWorkflowsModule } from './agent-workflows.module.js';
export { WorkflowsAgentRunner } from './workflows-agent-runner.js';
export { AgentRunFlow, AgentRunSegmentFlow } from './agent-run.flow.js';
export {
  AGENT_RUN_SEGMENT_WORKFLOW,
  AGENT_RUN_WORKFLOW,
  type AgentRunSegmentInput,
} from './agent-turn.executor.js';
export { AGENT_REPLY, type PendingReply, replyKey } from './agent-reply.signal.js';
