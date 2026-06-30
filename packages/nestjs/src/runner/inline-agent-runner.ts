import {
  type AgentRunInput,
  type AgentRunner,
  type AgentLoopHooks,
  type Decision,
  runAgentLoop,
} from '@dudousxd/nestjs-agent-core';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { AGENT_DEPS, type AgentDeps, utcDay } from '../agent-deps.js';

/**
 * Runs the agent turn in-process. HITL approval resolves a pending promise keyed by
 * `runId:toolCallId`. Single-replica only — the durable runner is the multi-replica path.
 */
@Injectable()
export class InlineAgentRunner implements AgentRunner {
  private readonly logger = new Logger(InlineAgentRunner.name);
  private readonly pending = new Map<string, (decision: Decision) => void>();

  constructor(@Inject(AGENT_DEPS) private readonly deps: AgentDeps) {}

  async start(input: AgentRunInput): Promise<{ runId: string }> {
    const runId = crypto.randomUUID();
    const day = input.day ?? utcDay();
    const hooks: AgentLoopHooks = {
      runId,
      openSink: () => this.deps.sink.open(runId),
      awaitApproval: (call) =>
        new Promise<Decision>((resolve) => {
          this.pending.set(`${runId}:${call.id}`, resolve);
        }),
      step: (_name, fn) => fn(),
    };

    void runAgentLoop({ ...this.deps, day }, input, hooks).catch(async (error) => {
      this.logger.error(`agent run ${runId} failed: ${error?.message ?? error}`);
      const writer = await this.deps.sink.open(runId);
      const message = error instanceof Error ? error.message : String(error);
      await writer.write(new TextEncoder().encode(`\n[error] ${message}`));
      await writer.end();
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
    const writer = await this.deps.sink.open(runId);
    await writer.end();
  }
}
