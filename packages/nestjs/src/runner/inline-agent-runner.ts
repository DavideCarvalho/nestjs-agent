import {
  AGENT_DEPS_FACTORY,
  AGENT_STORE,
  type Actor,
  type AgentLoopHooks,
  type AgentRunInput,
  type AgentRunner,
  type AgentStore,
  type Decision,
  QuotaExceededError,
  publishAgentRunFailed,
  runAgentLoop,
} from '@dudousxd/nestjs-agent-core';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { AgentDepsFactory } from '../agent-deps.factory.js';
import { type AgentDeps, childSinkWriter, utcDay } from '../agent-deps.js';

/**
 * Runs the agent turn in-process. HITL approval resolves a pending promise keyed by
 * `runId:toolCallId`. Sub-agent delegation runs a nested loop that streams into the top-level run's
 * sink (so a human sees it) and shares the same approval mechanism — a sub-agent's action tools go
 * through the same human gate, keyed by the sub-agent's own runId. Single-replica only (the pending
 * map is in-process); durable is the scaled path.
 */
@Injectable()
export class InlineAgentRunner implements AgentRunner {
  private readonly logger = new Logger(InlineAgentRunner.name);
  private readonly pending = new Map<string, (decision: Decision) => void>();

  constructor(
    @Inject(AGENT_DEPS_FACTORY) private readonly factory: AgentDepsFactory,
    @Inject(AGENT_STORE) private readonly store: AgentStore,
  ) {}

  async start(input: AgentRunInput): Promise<{ runId: string }> {
    const runId = crypto.randomUUID();
    const day = input.day ?? utcDay();
    const deps = this.factory.forAgent(input.agentName);
    const hooks = this.topLevelHooks(runId, deps, input.actor, day);

    void runAgentLoop({ ...deps, day }, input, hooks)
      .then(() => this.store.setActiveStream(input.threadId, null))
      .catch(async (error) => {
        const message = error instanceof Error ? error.message : String(error);
        const code = error instanceof QuotaExceededError ? 'quota_exceeded' : 'run_failed';
        this.logger.error(`agent run ${runId} failed (${code}): ${message}`);
        publishAgentRunFailed({ runId, code, message });
        // Clear the thread's active run — a failed run isn't "still running" for `activeRunForThread`.
        await this.store.setActiveStream(input.threadId, null);
        // Terminate the live stream with a typed failure so the transport emits an error frame
        // instead of leaking the message as assistant text.
        const writer = await deps.sink.open(runId);
        await writer.fail({ code, message });
      });

    return { runId };
  }

  async signal(runId: string, toolCallId: string, decision: Decision): Promise<void> {
    const key = `${runId}:${toolCallId}`;
    const resolve = this.pending.get(key);
    if (resolve !== undefined) {
      this.pending.delete(key);
      resolve(decision);
    }
  }

  async cancel(runId: string): Promise<void> {
    const deps = this.factory.forAgent();
    const writer = await deps.sink.open(runId);
    await writer.end();
  }

  private topLevelHooks(runId: string, deps: AgentDeps, actor: Actor, day: string): AgentLoopHooks {
    return {
      runId,
      openSink: () => deps.sink.open(runId),
      awaitApproval: (call) =>
        new Promise<Decision>((resolve) => {
          this.pending.set(`${runId}:${call.id}`, resolve);
        }),
      step: (_name, fn) => fn(),
      runAgent: (agentName, task) => this.runNested(agentName, task, actor, day, 1, runId),
    };
  }

  /**
   * Delegate to another agent as a nested in-process run. The sub-agent streams into `sinkRunId`
   * (the top-level run the human is watching) so its output and any pending action tool are visible,
   * and its own approvals resolve through the shared pending map keyed by its own runId.
   */
  private async runNested(
    agentName: string,
    task: string,
    actor: Actor,
    day: string,
    depth: number,
    sinkRunId: string,
  ): Promise<{ text: string }> {
    const subThread = await this.store.createThread({ actor, transient: true });
    const runId = crypto.randomUUID();
    // Mark the subthread as streaming THIS sub-run so a human approval routes back here
    // (runForToolCall → subthread.activeStreamId → this runId).
    await this.store.setActiveStream(subThread.id, runId);
    const deps = this.factory.forAgent(agentName);
    const hooks: AgentLoopHooks = {
      runId,
      // Forward into the top-level stream; the top-level run owns end/fail on that shared sink.
      openSink: async () => childSinkWriter(await deps.sink.open(sinkRunId)),
      awaitApproval: (call) =>
        new Promise<Decision>((resolve) => {
          this.pending.set(`${runId}:${call.id}`, resolve);
        }),
      step: (_name, fn) => fn(),
      runAgent: (childName, childTask) =>
        this.runNested(childName, childTask, actor, day, depth + 1, sinkRunId),
    };
    try {
      return await runAgentLoop(
        { ...deps, day },
        {
          threadId: subThread.id,
          actor,
          userText: task,
          agentName,
          day,
          delegationDepth: depth,
          sinkRunId,
        },
        hooks,
      );
    } finally {
      // No durable-style suspend to worry about here (inline runs to completion synchronously from
      // this call's point of view) — always clear so `activeRunForThread` reflects reality.
      await this.store.setActiveStream(subThread.id, null);
    }
  }
}
