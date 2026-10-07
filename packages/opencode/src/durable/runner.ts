import { randomUUID } from 'node:crypto';
import type {
  AgentRunInput,
  AgentRunStartOptions,
  AgentRunner,
  HumanReply,
} from '@dudousxd/nestjs-agent-core';
import { RUN_GATEWAY, WorkflowService } from '@dudousxd/nestjs-durable';
import { type RunGateway, isWorkflowControlFlowSignal } from '@dudousxd/nestjs-durable-core';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OpenCodeHost } from '../host.js';
import { OPENCODE_HOST, OPENCODE_OPTIONS } from '../tokens.js';
import { type OpenCodeEngineSettings, OpenCodeTurns } from '../turns.js';
import { OpenCodeRunWorkflow, decisionToken } from './workflow.js';

function isRunInput(value: unknown): value is AgentRunInput {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as AgentRunInput).threadId === 'string' &&
    typeof (value as AgentRunInput).actor === 'object'
  );
}

/**
 * Runs OpenCode turns as `@dudousxd/nestjs-durable` workflows ({@link OpenCodeRunWorkflow}): a
 * person's decision is a durable signal, so a turn waiting on one survives restarts and is resumed
 * by whichever process receives it. Needs a cross-process `TokenStreamSink` when more than one
 * process serves the agent.
 */
@Injectable()
export class DurableOpenCodeAgentRunner implements AgentRunner {
  private readonly logger = new Logger(DurableOpenCodeAgentRunner.name);

  constructor(
    private readonly workflows: WorkflowService,
    @Inject(RUN_GATEWAY) private readonly runs: RunGateway,
    private readonly turns: OpenCodeTurns,
    @Inject(OPENCODE_OPTIONS) private readonly settings: OpenCodeEngineSettings,
    @Inject(OPENCODE_HOST) private readonly host: OpenCodeHost,
  ) {
    turns.startNext = (next, runId) => this.start(next, { runId });
  }

  runIdFor(input: AgentRunInput): string {
    return this.settings.runId?.(input) ?? randomUUID();
  }

  async start(
    input: AgentRunInput,
    options: AgentRunStartOptions = {},
  ): Promise<{ runId: string }> {
    const runId = options.runId ?? this.runIdFor(input);
    const durable = this.settings.durable;
    const startOptions = {
      ...((await durable?.start?.(input, runId)) ?? {}),
      ...((await this.host.startOptions?.(input, runId)) ?? {}),
    };
    try {
      await this.workflows.start(
        OpenCodeRunWorkflow,
        input,
        runId,
        startOptions as Parameters<WorkflowService['start']>[3],
      );
    } catch (error) {
      // A run that suspends on its first step under a driving dispatcher surfaces the runtime's
      // suspend signal here: the run is persisted and will be resumed, not failed.
      if (isWorkflowControlFlowSignal(error)) return { runId };
      throw this.host.startError?.(error, input) ?? durable?.startError?.(error, input) ?? error;
    }
    return { runId };
  }

  async isRunActive(runId: string): Promise<boolean> {
    try {
      const status = (await this.runs.getRunDetail(runId))?.run.status;
      return !(
        status === 'completed' ||
        status === 'failed' ||
        status === 'cancelled' ||
        status === 'dead'
      );
    } catch {
      return true;
    }
  }

  async signal(runId: string, toolCallId: string, reply: HumanReply): Promise<void> {
    await this.workflows.signal(decisionToken(runId, toolCallId), reply);
  }

  /**
   * Interrupt OpenCode, cancel the run in the runtime (a run parked on a person never runs its body
   * again), and settle it here: the queue, the thread, the `cancelled` frame and the run row.
   */
  async cancel(runId: string): Promise<void> {
    this.logger.log(`cancelling agent run ${runId}`);
    const input = await this.runs
      .getRunDetail(runId)
      .then((detail) => detail?.run.input)
      .catch(() => undefined);
    if (isRunInput(input)) await this.turns.interrupt(input).catch(() => undefined);
    await this.runs.cancel(runId, { compensate: true });
    if (isRunInput(input)) await this.turns.settle(runId, input, { status: 'interrupted' }, 0);
  }
}
