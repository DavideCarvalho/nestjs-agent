import type { AgentRunInput, Decision, HumanReply } from '@dudousxd/nestjs-agent-core';
import { RUN_GATEWAY, Workflow } from '@dudousxd/nestjs-durable';
import {
  type RunGateway,
  SignalTimeoutError,
  type WorkflowCtx,
  isWorkflowControlFlowSignal,
} from '@dudousxd/nestjs-durable-core';
import { Inject, Injectable, Optional } from '@nestjs/common';
import type { OpenCodeTurnStop } from '../turn-limits.js';
import { type TurnOutcome, type TurnProgress, addUsage, emptyUsage, errorText } from '../turn.js';
import { OpenCodeTurns, type SessionHandle } from '../turns.js';

export const OPENCODE_RUN_WORKFLOW = 'agent.opencode.run';

/**
 * What a turn's workflow run returns: how it ended, and the reason of a stop that landed on it (a
 * limit, or `stopTurn`) — `failed` when the stop aborted it, `succeeded` when the answer was kept.
 */
export interface OpenCodeRunWorkflowResult {
  outcome: string;
  stop?: OpenCodeTurnStop['reason'];
}

/** The token a person's answer to `toolCallId` is signalled under — the library's own convention. */
export function decisionToken(runId: string, toolCallId: string): string {
  return `tool:${runId}:${toolCallId}`;
}

/**
 * An OpenCode turn as a durable workflow:
 *
 *   begin → prompt → observe:0 → [ wait for a person (signal `tool:<run>:<call>`) → reply:n → observe:n+1 ]* → finish
 *
 * Every step is checkpointed. A turn parked on a person is a suspended run with a signal waiter: an
 * API restart loses nothing, and the decision resumes it on whichever process takes it — replaying
 * the steps from their checkpoints and replying to OpenCode from there (`OpenCodeTurns` rebuilds the
 * live turn, and re-prompts a fresh session when OpenCode itself restarted meanwhile). A process
 * that dies while OpenCode works re-runs that `observe` step, which catches up on what OpenCode
 * asked while nobody listened, and — when the execution ends — on what it said: the text, tool
 * calls and usage it streamed meanwhile, read back from the session's messages.
 */
@Injectable()
@Workflow({ name: OPENCODE_RUN_WORKFLOW, version: '1' })
export class OpenCodeRunWorkflow {
  constructor(
    private readonly turns: OpenCodeTurns,
    @Optional() @Inject(RUN_GATEWAY) private readonly runs?: RunGateway,
  ) {}

  async run(ctx: WorkflowCtx, input: AgentRunInput): Promise<OpenCodeRunWorkflowResult> {
    // What the run spent: every milestone carries its share, journaled with it, so a run resumed in
    // another process adds up the same figure (a milestone journaled before usage travelled adds 0).
    let spent = emptyUsage();
    // What the turn took from the session up to its last ask, journaled with it: an `observe` re-run
    // after a restart reads back from the session only what came after.
    let progress: TurnProgress | undefined;
    try {
      const begun = await ctx.localStep('begin', async () => ({
        handle: await this.turns.begin(ctx.runId, input),
        startedAt: Date.now(),
      }));
      let handle: SessionHandle = begun.handle;
      await ctx.localStep('prompt', async () => {
        await this.turns.prompt(ctx.runId, input, handle, spent);
        return true;
      });
      for (let n = 0; ; n += 1) {
        const before = spent;
        const taken = progress;
        const milestone = await ctx.localStep(`observe:${n}`, () =>
          this.turns.observe(ctx.runId, input, handle, before, taken),
        );
        spent = addUsage(spent, milestone.usage);
        const total = spent;
        if (milestone.kind === 'finished') {
          // How the turn settled — a stop that landed after `observe` journaled included. A run
          // journaled before settle returned its outcome (`true`) reads the milestone's.
          const settled = await ctx.localStep('finish', async (): Promise<TurnOutcome | true> => {
            // A cancel settles the run itself (it may be parked where no step runs again).
            if (await this.cancelled(ctx.runId)) {
              await this.turns.abandon(ctx.runId);
              return milestone.outcome;
            }
            return this.turns.settle(
              ctx.runId,
              input,
              milestone.outcome,
              Date.now() - begun.startedAt,
              total,
            );
          });
          return resultOf(settled === true ? milestone.outcome : settled);
        }
        let reply: HumanReply;
        try {
          reply = await ctx.waitForSignal<HumanReply>(
            decisionToken(ctx.runId, milestone.ask.id),
            milestone.timeoutMs !== undefined ? { timeoutMs: milestone.timeoutMs } : undefined,
          );
        } catch (error) {
          if (!(error instanceof SignalTimeoutError)) throw error;
          reply = { approved: false, expired: true } satisfies Decision;
        }
        const ask = milestone.ask;
        progress = milestone.progress ?? progress;
        const tookSoFar = progress;
        handle = await ctx.localStep(`reply:${n}`, () =>
          this.turns.reply(ctx.runId, input, handle, ask, reply, total, tookSoFar),
        );
      }
    } catch (error) {
      if (isWorkflowControlFlowSignal(error)) throw error;
      const settled = await ctx.localStep(
        'fail',
        async (): Promise<TurnOutcome | true> =>
          this.turns.settleFailed(ctx.runId, input, errorText(error, 'the turn failed'), 0, spent),
      );
      return settled === true ? { outcome: 'failed' } : resultOf(settled);
    }
  }

  private async cancelled(runId: string): Promise<boolean> {
    try {
      const status = (await this.runs?.getRunDetail(runId))?.run.status;
      return status === 'cancelling' || status === 'cancelled';
    } catch {
      return false;
    }
  }
}

function resultOf(outcome: TurnOutcome): OpenCodeRunWorkflowResult {
  const stop = outcome.status === 'interrupted' ? undefined : outcome.stop;
  return { outcome: outcome.status, ...(stop !== undefined ? { stop: stop.reason } : {}) };
}
