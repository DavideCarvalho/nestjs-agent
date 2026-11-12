import {
  AGENT_DEPS_FACTORY,
  AGENT_OPTIONS,
  AGENT_STORE,
  type AgentLoopHooks,
  type AgentLoopResult,
  type AgentRunInput,
  type AgentStore,
  type AgentStreamEvent,
  type BufferedModelTurnResult,
  type Decision,
  type ElicitationReply,
  type HumanReply,
  type LlmStepEnvelope,
  RUN_ENDED_BEFORE_TOOL_CALL,
  RunCancelledError,
  type ToolCallRequest,
  type ToolStepEnvelope,
  agentFailureCode,
  agentRunContext,
  encodeStreamEvent,
  isReplayIntegrityError,
  publishAgentRunFailed,
  releaseThreadRun,
  runAgentLoop,
  runDurationMs,
  runEndTimings,
  settleAll,
  settleDeadRun,
  settleUnsettledDelegation,
  streamFailure,
} from '@dudousxd/nestjs-agent-core';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  ChildWorkflowFailedError,
  NonRetryableStepError,
  StepFailedError,
  WORKFLOWS_MODULE_OPTIONS,
  WorkflowClient,
  type WorkflowContext,
  type WorkflowsModuleOptions,
} from '@nestjs/workflows';
import type { AgentDepsFactory } from '../agent-deps.factory.js';
import { childSinkWriter, utcDay } from '../agent-deps.js';
import { type AgentModuleOptions, durableEngineOf } from '../agent.options.js';
import type {
  ChatQueueService,
  QueuePlan,
  QueueSettleOutcome,
} from '../queue/chat-queue.service.js';
import { AGENT_CHAT_QUEUE } from '../queue/chat-queue.token.js';
import { runLlmStep, runToolStep } from '../runner/agent-step-bodies.js';
import { AGENT_REPLY, type PendingReply, replyKey } from './agent-reply.signal.js';
import {
  SegmentBoundary,
  TurnJournal,
  type TurnOutcome,
  isEngineControlFlow,
  markControlFlow,
  rebuildTurnError,
  serializeTurnError,
  stepFailureCause,
} from './turn-journal.js';

/** The workflow a turn runs as. */
export const AGENT_RUN_WORKFLOW = 'aviary.agent.run';
/** The workflow a turn goes on in after `stepsPerInstance` model calls. */
export const AGENT_RUN_SEGMENT_WORKFLOW = 'aviary.agent.run.segment';

const DEFAULT_STEPS_PER_INSTANCE = 10;

/** What a segment instance starts from: the turn, its run id, and what the instances before it settled. */
export interface AgentRunSegmentInput {
  input: AgentRunInput;
  /** The turn's run id: the id of the instance it started in. */
  runId: string;
  /** 1 for the first child instance. */
  segment: number;
  carried: Record<string, TurnOutcome>;
}

/** A segment's failure, already settled by the segment that failed: its ancestors only pass it up. */
class SegmentFailed extends Error {
  constructor(override readonly cause: ChildWorkflowFailedError) {
    super(cause.message);
    this.name = 'SegmentFailed';
  }
}

/** A step body's outcome, as the journal keeps it: a step never fails for the loop's own errors. */
type StepEnvelope = { v?: unknown } | { e: ReturnType<typeof serializeTurnError> };

/** Errors that fail the same way every attempt: not worth a durable retry. */
function isConfigurationError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AiConfigurationError' || error.name === 'AgentConfigurationError')
  );
}

/** The engine refused the run's code (a duplicate name, a ctx call inside a step...): nothing more can be journaled. */
function isFatalDefinitionError(error: unknown): boolean {
  return (
    isReplayIntegrityError(error) ||
    (error instanceof Error &&
      (error.name === 'WorkflowDefinitionError' || error.name === 'WorkflowJournalLimitError'))
  );
}

/**
 * The agent turn on `@nestjs/workflows`: what `AgentRunFlow` (`aviary.agent.run`) and
 * `AgentRunSegmentFlow` run. Each model call and each tool call is a `ctx.step`, the loop's
 * checkpoints are `ctx.step`s too, a human's reply is a `ctx.waitForSignal(AGENT_REPLY, { key })`,
 * a delegation is `ctx.executeChild`, a detached delegation and the thread's next queued message are
 * `ctx.startChild(..., { parentClose: 'abandon' })`. A cancel is the engine's: `WorkflowClient.cancel`
 * stops the turn at its next `ctx` call, and `WorkflowsAgentRunner.cancel` settles the agent's own
 * state, as it does on the `aviary` engine.
 */
@Injectable()
export class AgentTurnExecutor {
  private readonly logger = new Logger('AgentRunFlow');
  private readonly stepsPerInstance: number;

  constructor(
    @Inject(AGENT_DEPS_FACTORY) private readonly factory: AgentDepsFactory,
    @Inject(AGENT_STORE) private readonly store: AgentStore,
    @Optional() @Inject(AGENT_OPTIONS) options?: AgentModuleOptions,
    // By token: this file ships in the `/workflows` bundle, whose copy of the `ChatQueueService`
    // class is not the one `AgentModule` provides.
    @Optional() @Inject(AGENT_CHAT_QUEUE) private readonly queue?: ChatQueueService,
    // `@Optional` so a missing WorkflowsModule reaches `WorkflowsAgentRunner`'s clear boot error.
    @Optional() private readonly client?: WorkflowClient,
    @Optional()
    @Inject(WORKFLOWS_MODULE_OPTIONS)
    private readonly workflowsOptions?: WorkflowsModuleOptions,
  ) {
    const durable = options?.durable;
    const configured =
      durableEngineOf(durable) === 'workflows' && typeof durable === 'object'
        ? durable.stepsPerInstance
        : undefined;
    this.stepsPerInstance =
      configured !== undefined && Number.isInteger(configured) && configured > 0
        ? configured
        : DEFAULT_STEPS_PER_INSTANCE;
  }

  /** A turn from its first instance. */
  run(ctx: WorkflowContext, input: AgentRunInput): Promise<AgentLoopResult> {
    return this.execute(ctx, { input, runId: ctx.workflowId, segment: 0, carried: {} });
  }

  async execute(ctx: WorkflowContext, segment: AgentRunSegmentInput): Promise<AgentLoopResult> {
    const { input, runId } = segment;
    const journal = new TurnJournal(segment.carried);
    const day = input.day ?? utcDay();
    const deps = this.factory.forAgent(input.agentName);
    const sinkRunId = input.sinkRunId ?? runId;
    const childSink = input.sinkRunId !== undefined;
    /** The original error of a checkpoint body that threw in THIS execution: rethrown as itself. */
    const originals = new Map<string, unknown>();
    /** The calls waiting for a person, shown as the instance's custom status. */
    const pending = new Map<string, PendingReply>();
    const showPending = () =>
      ctx.setStatus(pending.size > 0 ? { pendingReplies: [...pending.values()] } : null);

    /** A `ctx.step` whose body never fails the step: what it threw is journaled as its outcome. */
    const checkpoint = <T>(name: string, fn: () => Promise<T>): Promise<T> =>
      journal.op(name, async () => {
        const envelope = (await this.ctxCall(() =>
          ctx.step(name, async (): Promise<StepEnvelope> => {
            try {
              const value = await fn();
              return value === undefined ? {} : { v: value };
            } catch (error) {
              originals.set(name, error);
              return { e: serializeTurnError(error) };
            }
          }),
        )) as StepEnvelope;
        if ('e' in envelope) {
          throw originals.get(name) ?? rebuildTurnError(envelope.e);
        }
        return envelope.v as T;
      });
    const step = <T>(name: string, fn: () => Promise<T>): Promise<T> =>
      checkpoint(journal.unique(name), fn);

    /** Wait for a person's reply to call `id`, listed as pending meanwhile. */
    const awaitReply = async (
      call: { id: string; toolName: string; kind: PendingReply['kind'] },
      timeoutMs?: number,
    ): Promise<HumanReply | null> => {
      const name = journal.unique(`reply:${call.id}`);
      pending.set(call.id, {
        key: replyKey(runId, call.id),
        runId,
        toolCallId: call.id,
        toolName: call.toolName,
        kind: call.kind,
      });
      showPending();
      const reply = await journal.op(name, () =>
        this.ctxCall(() =>
          ctx.waitForSignal(name, AGENT_REPLY, {
            key: replyKey(runId, call.id),
            ...(timeoutMs !== undefined ? { timeout: timeoutMs } : {}),
          }),
        ),
      );
      // Not on a suspension: the status written as the instance parks must still list the call.
      pending.delete(call.id);
      showPending();
      return reply as HumanReply | null;
    };

    const chainBelow = [
      ...(input.delegationPath ?? []),
      ...(input.agentName !== undefined ? [input.agentName] : []),
    ];
    const subThread = (agentName: string) =>
      step(`subthread:${agentName}`, async () => {
        const thread = await this.store.createThread({ actor: input.actor, transient: true });
        return thread.id;
      });

    if (input.sinkRunId !== undefined || input.deliverTo !== undefined) {
      await step('activate', () => this.store.setActiveStream(input.threadId, runId));
    }

    const hooks: AgentLoopHooks = {
      runId,
      queueMs: async () => {
        const status = await this.client?.getStatus(runId);
        if (status === undefined || status === null) return undefined;
        const now = this.workflowsOptions?.clock?.now() ?? Date.now();
        const waited = now - status.createdAt;
        return Number.isFinite(waited) && waited >= 0 ? waited : undefined;
      },
      openSink: async () => {
        if (childSink) {
          return childSinkWriter(await deps.sink.open(sinkRunId));
        }
        const writer = await deps.sink.open(runId);
        return {
          write: (chunk) => writer.write(chunk),
          fail: (failure) => writer.fail(failure),
          end: async () => {
            const frame = await this.advanceQueue(ctx, step, journal, runId, input, 'completed');
            if (frame !== undefined) {
              await writer.write(encodeStreamEvent(frame));
            }
            await writer.end();
          },
        };
      },
      awaitApproval: async (call: ToolCallRequest, _toolCtx, opts) => {
        const reply = await awaitReply(
          { id: call.id, toolName: call.name, kind: 'approval' },
          opts?.timeoutMs,
        );
        return reply === null
          ? ({ approved: false, expired: true } satisfies Decision)
          : (reply as Decision);
      },
      awaitAnswers: async (request) => {
        const reply = await awaitReply({
          id: request.id,
          toolName: request.source,
          kind: 'elicitation',
        });
        return (reply ?? { approved: false }) as ElicitationReply | Decision;
      },
      step,
      parallel: settleAll,
      isControlFlowError: isEngineControlFlow,
      runAgent: async (agentName, task, options) => {
        // Named on the call, before any await: parallel delegations get the same names on a replay.
        const name = journal.unique(`delegate:${agentName}`);
        const subThreadId = await subThread(agentName);
        const child: AgentRunInput = {
          agentName,
          threadId: subThreadId,
          actor: input.actor,
          userText: task,
          day,
          delegationDepth: (input.delegationDepth ?? 0) + 1,
          delegationPath: chainBelow,
          parentRunId: runId,
          sinkRunId,
          // The delegate's own model (journaled in the claim), never this turn's pick.
          ...(options?.model !== undefined ? { model: options.model } : {}),
        };
        return journal.op(name, () =>
          this.ctxCall(() =>
            ctx.executeChild<{
              run(c: WorkflowContext, i: AgentRunInput): Promise<AgentLoopResult>;
            }>(AGENT_RUN_WORKFLOW, child, { id: `${ctx.workflowId}/${name}` }),
          ),
        ) as Promise<{ text: string }>;
      },
      // A detached delegation outlives the turn that started it, and a Stop on that turn: an
      // abandoned child, not a cancelled one.
      startAgent: async ({ agentName, task, toolCallId, model }) => {
        const name = journal.unique(`detach:${toolCallId}`);
        const subThreadId = await subThread(agentName);
        const child: AgentRunInput = {
          agentName,
          threadId: subThreadId,
          actor: input.actor,
          userText: task,
          day,
          delegationDepth: (input.delegationDepth ?? 0) + 1,
          delegationPath: chainBelow,
          parentRunId: runId,
          deliverTo: { threadId: input.threadId, toolCallId },
          ...(model !== undefined ? { model } : {}),
        };
        const childRunId = await journal.op(name, async () => {
          const handle = await this.ctxCall(() =>
            ctx.startChild(AGENT_RUN_WORKFLOW, child, {
              id: `${runId}.detached.${toolCallId}`,
              parentClose: 'abandon',
            }),
          );
          return handle.id;
        });
        return { runId: childRunId };
      },
      dispatchLlm: (index: number, envelope: LlmStepEnvelope) => {
        const name = journal.unique(`llm:${index}`);
        if (!journal.has(name)) {
          if (journal.liveModelCalls >= this.stepsPerInstance) {
            throw new SegmentBoundary();
          }
          journal.liveModelCalls += 1;
        }
        return journal.op(name, async () => {
          try {
            return (await this.ctxCall(() =>
              ctx.step(name, (attempt) =>
                runLlmStep(
                  this.factory,
                  { ...envelope, runId, step: index, sinkRunId, childSink },
                  { abortSignal: attempt.signal },
                ).catch((error: unknown) => {
                  if (!isConfigurationError(error)) throw error;
                  const fatal = new NonRetryableStepError((error as Error).message);
                  fatal.name = (error as Error).name;
                  throw fatal;
                }),
              ),
            )) as BufferedModelTurnResult;
          } catch (error) {
            // The model's own failure, as the loop knows it: `No output generated`, a provider error.
            if (error instanceof StepFailedError) {
              throw rebuildTurnError(stepFailureCause(error));
            }
            throw error;
          }
        });
      },
      // A tool's failure is a result the model reads, not the step's: the step is retried only after
      // a crash, and the tool's `ctx.idempotencyKey` (`<runId>:<toolCallId>`) is the same on that
      // attempt, so a tool that passes it on does its side effect once.
      dispatchTool: (call: ToolCallRequest, envelope: ToolStepEnvelope) =>
        checkpointTool(journal.unique(`tool:${call.id}`), call, envelope),
    };

    const checkpointTool = (name: string, call: ToolCallRequest, envelope: ToolStepEnvelope) =>
      journal.op(name, async () => {
        const outcome = (await this.ctxCall(() =>
          ctx.step(name, async (attempt): Promise<StepEnvelope> => {
            try {
              const value = await runToolStep(
                this.factory,
                {
                  ...envelope,
                  toolCallId: call.id,
                  toolType: call.kind === 'action' ? 'action' : 'read',
                  sinkRunId,
                  childSink,
                },
                { abortSignal: attempt.signal },
              );
              return value === undefined ? {} : { v: value };
            } catch (error) {
              originals.set(name, error);
              return { e: serializeTurnError(error) };
            }
          }),
        )) as StepEnvelope;
        if ('e' in outcome) throw originals.get(name) ?? rebuildTurnError(outcome.e);
        return outcome.v;
      });

    try {
      const result = await runAgentLoop({ ...deps, day }, input, hooks);
      await step('deactivate', () => releaseThreadRun(this.store, input.threadId, runId));
      return result;
    } catch (error) {
      if (error instanceof SegmentBoundary) {
        return this.continueInSegment(ctx, { ...segment, carried: journal.outcomes });
      }
      if (isEngineControlFlow(error) || error instanceof SegmentFailed) {
        throw error;
      }
      if (error instanceof RunCancelledError) {
        await step('deactivate', () => releaseThreadRun(this.store, input.threadId, runId));
        await this.settleDetachedParent(step, runId, input, { status: 'cancelled' });
        throw error;
      }
      const durationMs = runDurationMs(error);
      const timed = durationMs !== undefined ? { durationMs } : {};
      const measured = runEndTimings(error);
      const message = error instanceof Error ? error.message : String(error);
      const code = agentFailureCode(error);
      this.logger.error(`agent run ${runId} failed (${code}): ${message}`);
      publishAgentRunFailed({
        runId,
        threadId: input.threadId,
        code,
        message,
        ...timed,
        ...measured,
        context: agentRunContext(input),
      });
      if (isFatalDefinitionError(error)) {
        // The engine will journal nothing more for this run: settle it straight in the store.
        await settleDeadRun(this.store, {
          runId,
          threadId: input.threadId,
          failure: { code, message, ...timed },
        });
        await (await hooks.openSink()).fail(streamFailure(error));
        throw error;
      }
      try {
        await step('persist:run:fail', async () => {
          await this.store.recordRunEnd?.({
            runId,
            status: 'failed',
            ...timed,
            errorCode: code,
            errorMessage: message,
          });
          await Promise.resolve(
            this.store.failUnsettledToolCalls?.(runId, RUN_ENDED_BEFORE_TOOL_CALL),
          ).catch(() => 0);
        });
        const queueFrame = await this.advanceQueue(
          ctx,
          step,
          journal,
          runId,
          input,
          'failed',
          message,
        );
        await step('deactivate', () => releaseThreadRun(this.store, input.threadId, runId));
        await this.settleDetachedParent(step, runId, input, { status: 'failed', error: message });
        const writer = await hooks.openSink();
        if (queueFrame !== undefined) {
          await writer.write(encodeStreamEvent(queueFrame));
        }
        await writer.fail(streamFailure(error));
      } catch (settling) {
        // A suspend while settling (a checkpoint's retry backoff) settles on the next execution.
        if (isEngineControlFlow(settling)) throw markControlFlow(settling);
        throw settling;
      }
      throw error;
    }
  }

  /** The turn goes on in a child instance, from what this one (and those before it) settled. */
  private async continueInSegment(
    ctx: WorkflowContext,
    segment: AgentRunSegmentInput,
  ): Promise<AgentLoopResult> {
    const next: AgentRunSegmentInput = { ...segment, segment: segment.segment + 1 };
    try {
      return (await this.ctxCall(() =>
        ctx.executeChild(AGENT_RUN_SEGMENT_WORKFLOW, next, {
          id: `${segment.runId}~${next.segment}`,
        }),
      )) as AgentLoopResult;
    } catch (error) {
      // The segment that failed settled the run (its row, its stream, its queue): pass it up.
      if (error instanceof ChildWorkflowFailedError) throw new SegmentFailed(error);
      throw error;
    }
  }

  /**
   * Hand the thread on past this settling turn, as the `aviary` engine does: the decision is one
   * checkpoint, and the next message starts as an abandoned child under its own id, so the turn
   * ending doesn't cancel it.
   */
  private async advanceQueue(
    ctx: WorkflowContext,
    step: <T>(name: string, fn: () => Promise<T>) => Promise<T>,
    journal: TurnJournal,
    runId: string,
    input: AgentRunInput,
    outcome: QueueSettleOutcome,
    error?: string,
  ): Promise<AgentStreamEvent | undefined> {
    const queue = this.queue;
    if (
      queue === undefined ||
      !queue.supported ||
      input.sinkRunId !== undefined ||
      input.deliverTo !== undefined
    ) {
      return undefined;
    }
    const plan = await step(`queue:${outcome}`, async (): Promise<QueuePlan> => {
      try {
        const settled =
          outcome === 'completed' && (await this.isCancelled(runId)) ? 'cancelled' : outcome;
        return await queue.plan({
          threadId: input.threadId,
          runId,
          outcome: settled,
          ...(error !== undefined ? { error } : {}),
        });
      } catch {
        return {};
      }
    });
    const next = plan.next;
    if (next === undefined) {
      return plan.frame;
    }
    try {
      await journal.op(journal.unique(`queue:start:${next.runId}`), async () => {
        const handle = await this.ctxCall(() =>
          ctx.startChild(AGENT_RUN_WORKFLOW, next.input, {
            id: next.runId,
            parentClose: 'abandon',
          }),
        );
        return handle.id;
      });
      return plan.frame;
    } catch (failure) {
      if (isEngineControlFlow(failure)) throw failure;
      const reason = failure instanceof Error ? failure.message : String(failure);
      return step('queue:restore', async () => {
        await queue.restore(input.threadId, next, 'start_failed', reason);
        return queue.pausedFrame(input.threadId);
      });
    }
  }

  private async isCancelled(runId: string): Promise<boolean> {
    try {
      return (await this.client?.getStatus(runId))?.cancelRequested === true;
    } catch {
      return false;
    }
  }

  private async settleDetachedParent(
    step: <T>(name: string, fn: () => Promise<T>) => Promise<T>,
    runId: string,
    input: AgentRunInput,
    outcome: { status: 'failed' | 'cancelled'; error?: string },
  ): Promise<void> {
    const delivery = input.deliverTo;
    if (delivery === undefined) return;
    await step('deliver:detached:unsettled', () =>
      settleUnsettledDelegation({
        store: this.store,
        delivery,
        agent: input.agentName ?? 'default',
        runId,
        status: outcome.status,
        ...(outcome.error !== undefined ? { error: outcome.error } : {}),
      }),
    );
  }

  /** A `ctx` call whose interrupt carries core's control-flow marker. */
  private async ctxCall<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      throw markControlFlow(error);
    }
  }
}
