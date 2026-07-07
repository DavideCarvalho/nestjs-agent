import type { AgentRunInput, Decision } from '../types.js';

/**
 * Runs an agent turn. Two impls exist:
 *  - InlineAgentRunner (default): the loop runs in-process — no extra dependencies. This is what
 *    `AGENT_RUNNER` binds to unless `durable: true` is set.
 *  - DurableAgentRunner (opt-in via `durable: true`): the turn is a `@dudousxd/nestjs-durable`
 *    `@Workflow`, so each model/tool call is a checkpointed step and HITL is `ctx.waitForSignal`.
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
