import type { AgentRunInput, Decision } from '../types.js';

/**
 * Runs an agent turn. Two impls exist:
 *  - DurableAgentRunner (default): the turn is a `@dudousxd/nestjs-durable` `@Workflow`,
 *    so each model/tool call is a checkpointed step and HITL is `ctx.waitForSignal`.
 *  - InlineAgentRunner (fallback/tests): the loop runs in-process.
 *
 * `start` ENQUEUES and returns immediately with the runId — the live tokens flow on the
 * TokenStreamSink, not through this call.
 */
export interface AgentRunner {
  start(input: AgentRunInput): Promise<{ runId: string }>;
  /** Deliver a HITL decision for a pending action tool call. */
  signal(runId: string, toolCallId: string, decision: Decision): Promise<void>;
  cancel(runId: string): Promise<void>;
}
