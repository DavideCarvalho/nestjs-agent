import type { AgentLoopResult, AgentRunInput } from '@dudousxd/nestjs-agent-core';
import { Workflow, type WorkflowContext, type WorkflowRunner } from '@nestjs/workflows';
import {
  AGENT_RUN_SEGMENT_WORKFLOW,
  AGENT_RUN_WORKFLOW,
  type AgentRunSegmentInput,
  AgentTurnExecutor,
} from './agent-turn.executor.js';

/** An agent turn, as a `@nestjs/workflows` workflow (`aviary.agent.run`). The run id is its instance id. */
@Workflow(AGENT_RUN_WORKFLOW)
export class AgentRunFlow implements WorkflowRunner<AgentRunInput, AgentLoopResult> {
  constructor(private readonly turns: AgentTurnExecutor) {}

  run(ctx: WorkflowContext, input: AgentRunInput): Promise<AgentLoopResult> {
    return this.turns.run(ctx, input);
  }
}

/** A turn going on in a child instance after `stepsPerInstance` model calls. Internal. */
@Workflow(AGENT_RUN_SEGMENT_WORKFLOW)
export class AgentRunSegmentFlow implements WorkflowRunner<AgentRunSegmentInput, AgentLoopResult> {
  constructor(private readonly turns: AgentTurnExecutor) {}

  run(ctx: WorkflowContext, segment: AgentRunSegmentInput): Promise<AgentLoopResult> {
    return this.turns.execute(ctx, segment);
  }
}
