import type { AgentRunInput, HumanReply } from '../types.js';

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
/** How {@link AgentRunner.start} starts a run. */
export interface AgentRunStartOptions {
  /**
   * Use this id for the run instead of minting one. The chat queue claims the thread for a run
   * BEFORE starting it (so no second turn can slip in between), which needs the id up front; a
   * queued message's run id is the message's own id, which also makes a retried start idempotent.
   * A runner that ignores it still works — the service then re-points the thread at the id it
   * returned.
   */
  runId?: string;
}

export interface AgentRunner {
  start(input: AgentRunInput, options?: AgentRunStartOptions): Promise<{ runId: string }>;
  /**
   * OPTIONAL: the id a run of `input` should have, when the caller mints one before starting it (the
   * chat queue claims a thread under the id first). A host whose ids carry meaning — a tenant
   * prefix its durable store partitions by — answers here. Absent → a random UUID.
   */
  runIdFor?(input: AgentRunInput): string;
  /**
   * OPTIONAL: whether `runId` is still running (or parked, or about to start) as far as this runner
   * can tell. Asked when a thread's admission is held by a run, to tell a live holder from a stale
   * one a crashed process left behind — a stale holder is replaced instead of queueing behind it
   * for ever. Answer `true` when unsure: a wrong `false` starts a second turn on the thread. Absent
   * → every holder is treated as live.
   */
  isRunActive?(runId: string): Promise<boolean>;
  /**
   * Deliver a human's reply to a parked tool call — a {@link import('../types.js').Decision} on an
   * action tool, or an `ElicitationReply` answering a question set. One channel for both, because
   * both park the run the same way and a runner has no reason to tell them apart.
   */
  signal(runId: string, toolCallId: string, reply: HumanReply): Promise<void>;
  cancel(runId: string): Promise<void>;
}
