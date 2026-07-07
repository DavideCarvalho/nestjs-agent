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
import { type AgentDeps, utcDay } from '../agent-deps.js';

/**
 * Runs the agent turn in-process. HITL approval resolves a pending promise keyed by
 * `runId:toolCallId`. Sub-agent delegation runs a nested loop (a nested sub-agent cannot prompt a
 * human, so its action tools are auto-declined). Single-replica only — durable is the scaled path.
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

    void runAgentLoop({ ...deps, day }, input, hooks).catch(async (error) => {
      const message = error instanceof Error ? error.message : String(error);
      const code = error instanceof QuotaExceededError ? 'quota_exceeded' : 'run_failed';
      this.logger.error(`agent run ${runId} failed (${code}): ${message}`);
      publishAgentRunFailed({ runId, code, message });
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
      runAgent: (agentName, task) => this.runNested(agentName, task, actor, day, 1),
    };
  }

  /** Delegate to another agent as a nested in-process run at the given delegation depth. */
  private async runNested(
    agentName: string,
    task: string,
    actor: Actor,
    day: string,
    depth: number,
  ): Promise<{ text: string }> {
    const subThread = await this.store.createThread({ actor, persona: 'default', transient: true });
    const runId = crypto.randomUUID();
    const deps = this.factory.forAgent(agentName);
    const hooks: AgentLoopHooks = {
      runId,
      openSink: () => deps.sink.open(runId),
      // A nested sub-agent has no human to ask — decline action tools rather than hang.
      awaitApproval: async () => ({
        approved: false,
        reason: 'nested sub-agent cannot request human approval',
      }),
      step: (_name, fn) => fn(),
      runAgent: (childName, childTask) =>
        this.runNested(childName, childTask, actor, day, depth + 1),
    };
    return runAgentLoop(
      { ...deps, day },
      { threadId: subThread.id, actor, userText: task, agentName, day, delegationDepth: depth },
      hooks,
    );
  }
}
