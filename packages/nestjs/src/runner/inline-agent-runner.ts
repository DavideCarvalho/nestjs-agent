import {
  AGENT_DEPS_FACTORY,
  AGENT_STORE,
  type Actor,
  type AgentLoopHooks,
  type AgentRunInput,
  type AgentRunStartOptions,
  type AgentRunner,
  type AgentStore,
  type Decision,
  type DetachedDelivery,
  type ElicitationReply,
  type HumanReply,
  RUN_ENDED_BEFORE_TOOL_CALL,
  RunCancelledError,
  type SinkWriter,
  agentFailureCode,
  encodeStreamEvent,
  publishAgentRunFailed,
  releaseThreadRun,
  runAgentLoop,
  settleAll,
  settleUnsettledDelegation,
  streamFailure,
} from '@dudousxd/nestjs-agent-core';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { AgentDepsFactory } from '../agent-deps.factory.js';
import { type AgentDeps, childSinkWriter, utcDay } from '../agent-deps.js';
import { ChatQueueService, type QueueSettleOutcome } from '../queue/chat-queue.service.js';

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
  private readonly pending = new Map<
    string,
    { resolve: (reply: HumanReply) => void; reject: (error: unknown) => void }
  >();
  /**
   * Runs someone has asked to stop. In-process, like `pending`, and for the same reason: this runner
   * is single-replica by construction, so the request is readable by the only loop that could be
   * running it. A cancelled id is dropped once the run settles, so the set tracks live runs only.
   */
  private readonly cancelled = new Set<string>();
  /** Top-level runs this process is running now — what {@link isRunActive} answers from. */
  private readonly live = new Set<string>();

  constructor(
    @Inject(AGENT_DEPS_FACTORY) private readonly factory: AgentDepsFactory,
    @Inject(AGENT_STORE) private readonly store: AgentStore,
    @Optional() private readonly queue?: ChatQueueService,
  ) {}

  /**
   * In-process, so exact: a run this process is not running is not running anywhere — the process
   * that was running it is gone (a restart), and a thread it still holds is a stale claim.
   */
  async isRunActive(runId: string): Promise<boolean> {
    if (this.live.has(runId)) {
      return true;
    }
    // A delegated run is not in `live` (it holds no thread of its own turn), but one parked on a
    // person is as alive as its parent: its decision has somewhere to go.
    for (const key of this.pending.keys()) {
      if (key.startsWith(`${runId}:`)) {
        return true;
      }
    }
    return false;
  }

  async start(
    input: AgentRunInput,
    options: AgentRunStartOptions = {},
  ): Promise<{ runId: string }> {
    const runId = options.runId ?? crypto.randomUUID();
    const day = input.day ?? utcDay();
    const deps = this.factory.forAgent(input.agentName);
    this.live.add(runId);
    const hooks = this.topLevelHooks({
      runId,
      deps,
      actor: input.actor,
      day,
      threadId: input.threadId,
      chainBelow: [
        ...(input.delegationPath ?? []),
        ...(input.agentName !== undefined ? [input.agentName] : []),
      ],
      input,
    });

    void runAgentLoop({ ...deps, day }, input, hooks)
      .then(() => releaseThreadRun(this.store, input.threadId, runId))
      .catch(async (error) => {
        if (error instanceof RunCancelledError) {
          await this.settleCancelled(runId, input, deps);
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        const code = agentFailureCode(error);
        this.logger.error(`agent run ${runId} failed (${code}): ${message}`);
        publishAgentRunFailed({ runId, code, message });
        // Settle the run's persisted outcome (the loop only records completions — it can't catch
        // its own crash). Optional-call: a store without run recording skips reliability metrics.
        await this.store.recordRunEnd?.({
          runId,
          status: 'failed',
          errorCode: code,
          errorMessage: message,
        });
        // A call this run had put to a person is not waiting for anything any more.
        await Promise.resolve(
          this.store.failUnsettledToolCalls?.(runId, RUN_ENDED_BEFORE_TOOL_CALL),
        ).catch(() => 0);
        const writer = await deps.sink.open(runId);
        // The queue behind it pauses (a failed turn's next message would likely fail the same way),
        // told to the reader before the error frame.
        await this.settleQueue(writer, input, runId, 'failed', message);
        // Clear the thread's active run — a failed run isn't "still running" for `activeRunForThread`.
        await releaseThreadRun(this.store, input.threadId, runId);
        // Terminate the live stream with a typed failure so the transport emits an error frame
        // instead of leaking the message as assistant text. The frame is for the person reading the
        // chat; the error itself went to the log and the run row above.
        await writer.fail(streamFailure(error));
      })
      .finally(() => {
        this.cancelled.delete(runId);
        this.live.delete(runId);
      });

    return { runId };
  }

  async signal(runId: string, toolCallId: string, reply: HumanReply): Promise<void> {
    const key = `${runId}:${toolCallId}`;
    const waiter = this.pending.get(key);
    if (waiter !== undefined) {
      this.pending.delete(key);
      waiter.resolve(reply);
    }
  }

  /**
   * Ask a run to stop, and settle whatever it was parked on.
   *
   * The loop observes the request at its next safe point (between steps, before the turn's tools) and
   * unwinds from there — so a tool already executing is left to finish, and its result is recorded
   * exactly as it would have been. What this cannot wait for is a turn parked on a human: that wait
   * is a promise nobody is going to resolve, so it is REJECTED here with the same
   * {@link RunCancelledError} the loop would have thrown, and the run unwinds through the identical
   * path.
   *
   * Settlement — the run row, the thread's active stream, the stream's terminal — belongs to the
   * `RunCancelledError` catch in `start`, so a cancel and an ordinary failure settle in one place
   * each and can never both write.
   */
  async cancel(runId: string): Promise<void> {
    this.cancelled.add(runId);
    for (const [key, waiter] of this.pending) {
      if (key.startsWith(`${runId}:`)) {
        this.pending.delete(key);
        waiter.reject(new RunCancelledError());
      }
    }
    await Promise.resolve();
  }

  /**
   * The single place a cancelled run's state is settled: recorded as its own terminal (never
   * `failed` — a user pressing Stop must not land in someone's error rate), the thread released, and
   * the stream ENDED after a `cancelled` frame rather than failed, so a client that retries failed
   * streams does not retry this one.
   */
  private async settleCancelled(
    runId: string,
    input: AgentRunInput,
    deps: AgentDeps,
  ): Promise<void> {
    this.logger.log(`agent run ${runId} cancelled`);
    const writer = await deps.sink.open(runId);
    // An interrupt's message starts now; otherwise the queue pauses behind the Stop.
    await this.settleQueue(writer, input, runId, 'cancelled');
    await releaseThreadRun(this.store, input.threadId, runId);
    await writer.write(encodeStreamEvent({ kind: 'cancelled' }));
    await writer.end();
    // Last, so the reader is released before the bookkeeping: everything above is what someone is
    // waiting on, and the run row is what someone reads afterwards.
    await this.store.recordRunEnd?.({ runId, status: 'cancelled' });
  }

  /**
   * Move the thread past a settling TOP-LEVEL run — to the next queued message, which starts here,
   * or to a paused/empty queue — and write the resulting `queue` frame into this run's stream. A
   * no-op without a queue-capable store, and for a run that is not a thread's own turn.
   *
   * Never throws: the run is settling either way, and a queue that could not be advanced is picked
   * up by the next send or resume on the thread.
   */
  private async settleQueue(
    writer: SinkWriter,
    input: AgentRunInput,
    runId: string,
    outcome: QueueSettleOutcome,
    error?: string,
  ): Promise<void> {
    const queue = this.queue;
    if (queue === undefined || !queue.supported || !isThreadTurn(input)) {
      return;
    }
    // A Stop that arrived too late to interrupt anything (the turn's last model call was already
    // answering) still means stop: the queue behind it pauses as it would after a cancel.
    const settled = outcome === 'completed' && this.cancelled.has(runId) ? 'cancelled' : outcome;
    try {
      const frame = await queue.handoff(
        {
          threadId: input.threadId,
          runId,
          outcome: settled,
          ...(error !== undefined ? { error } : {}),
        },
        (next, nextRunId) => this.start(next, { runId: nextRunId }),
      );
      if (frame !== undefined) {
        await writer.write(encodeStreamEvent(frame));
      }
    } catch (failure) {
      this.logger.error(
        `could not advance the queue of thread ${input.threadId} after run ${runId}: ${
          failure instanceof Error ? failure.message : String(failure)
        }`,
      );
    }
  }

  /**
   * Park a run on a human, keyed by run + tool call. One map for approvals and for question-set
   * answers alike: both wait on the same key, and `signal` cannot tell (or need to tell) which
   * shape it is delivering — the loop asked for one and only ever gets what the caller sent. A
   * cancel settles the wait too, by rejecting it.
   */
  /**
   * {@link park} for an approval, bounded by the policy's time to live when it has one: the timer
   * settles the wait as `expired` — the same Decision the durable runner builds from its signal
   * timeout — and a decision that arrives first disarms it.
   */
  private parkApproval(runId: string, toolCallId: string, timeoutMs?: number): Promise<Decision> {
    const waiting = this.park<Decision>(runId, toolCallId);
    if (timeoutMs === undefined) {
      return waiting;
    }
    const key = `${runId}:${toolCallId}`;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const lapse = new Promise<Decision>((resolve) => {
      timer = setTimeout(() => {
        const entry = this.pending.get(key);
        if (entry !== undefined) {
          this.pending.delete(key);
          resolve({ approved: false, expired: true });
        }
      }, timeoutMs);
      // A parked request must not keep the process alive on its own.
      timer.unref?.();
    });
    return Promise.race([waiting, lapse]).finally(() => clearTimeout(timer));
  }

  private park<T extends HumanReply>(runId: string, toolCallId: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.set(`${runId}:${toolCallId}`, {
        resolve: resolve as (reply: HumanReply) => void,
        reject,
      });
    });
  }

  private topLevelHooks(args: {
    runId: string;
    deps: AgentDeps;
    actor: Actor;
    day: string;
    threadId: string;
    /** This run's delegation chain with its own agent appended — see `AgentRunInput.delegationPath`. */
    chainBelow: readonly string[];
    input: AgentRunInput;
  }): AgentLoopHooks {
    const { runId, deps, actor, day, threadId, chainBelow, input } = args;
    return {
      runId,
      // The loop ends the stream when the turn completes. Just before, the thread passes to the next
      // queued message (or is released), and the reader is told which — so by the time a client
      // sees the run end, the thread is already free or already running what it queued.
      openSink: async () => {
        const writer = await deps.sink.open(runId);
        return this.queue === undefined
          ? writer
          : {
              write: (chunk) => writer.write(chunk),
              fail: (error) => writer.fail(error),
              end: async () => {
                await this.settleQueue(writer, input, runId, 'completed');
                await writer.end();
              },
            };
      },
      awaitApproval: (call, _ctx, opts) => this.parkApproval(runId, call.id, opts?.timeoutMs),
      awaitAnswers: (request) => this.park<ElicitationReply>(runId, request.id),
      step: (_name, fn) => fn(),
      parallel: settleAll,
      cancelled: async () => this.cancelled.has(runId),
      runAgent: (agentName, task) =>
        this.runNested({
          agentName,
          task,
          actor,
          day,
          depth: 1,
          path: chainBelow,
          sinkRunId: runId,
          parentRunId: runId,
        }),
      startAgent: ({ agentName, task, toolCallId }) =>
        this.startDetached({
          agentName,
          task,
          actor,
          day,
          depth: 1,
          path: chainBelow,
          parentRunId: runId,
          deliverTo: { threadId, toolCallId },
        }),
    };
  }

  /**
   * Delegate WITHOUT waiting: a nested loop nobody awaits, on its own thread and its own sink, which
   * posts its answer back into the delegating thread when it lands (`deliverTo`, settled by the
   * loop). The calling turn gets the run id straight back and finishes.
   *
   * No `sinkRunId`, unlike {@link runNested}: forwarding into the stream the human is watching would
   * write into a turn that has already ended. Its own approvals resolve through the shared pending
   * map keyed by its own runId — which is what the pending-approvals surface routes to.
   */
  private async startDetached(args: {
    agentName: string;
    task: string;
    actor: Actor;
    day: string;
    depth: number;
    /** The chain that reached this child, root first. */
    path: readonly string[];
    parentRunId: string;
    deliverTo: DetachedDelivery;
  }): Promise<{ runId: string }> {
    const { agentName, task, actor, day, depth, path, parentRunId, deliverTo } = args;
    const subThread = await this.store.createThread({ actor, transient: true });
    const runId = crypto.randomUUID();
    // Marks the subthread as streaming this run, exactly as a sub-agent's does: it is what routes a
    // human decision on its action tools back to it, and what lets a client attach to its stream.
    await this.store.setActiveStream(subThread.id, runId);
    const deps = this.factory.forAgent(agentName);
    const hooks: AgentLoopHooks = {
      runId,
      openSink: () => deps.sink.open(runId),
      awaitApproval: (call, _ctx, opts) => this.parkApproval(runId, call.id, opts?.timeoutMs),
      awaitAnswers: (request) => this.park<ElicitationReply>(runId, request.id),
      step: (_name, fn) => fn(),
      parallel: settleAll,
      cancelled: async () => this.cancelled.has(runId),
      runAgent: (childName, childTask) =>
        this.runNested({
          agentName: childName,
          task: childTask,
          actor,
          day,
          depth: depth + 1,
          path: [...path, agentName],
          // A detached run owns a stream of its own, so ITS sub-agents forward into that one.
          sinkRunId: runId,
          parentRunId: runId,
        }),
      startAgent: ({ agentName: childName, task: childTask, toolCallId }) =>
        this.startDetached({
          agentName: childName,
          task: childTask,
          actor,
          day,
          depth: depth + 1,
          path: [...path, agentName],
          parentRunId: runId,
          deliverTo: { threadId: subThread.id, toolCallId },
        }),
    };
    void runAgentLoop(
      { ...deps, day },
      {
        threadId: subThread.id,
        actor,
        userText: task,
        agentName,
        day,
        delegationDepth: depth,
        delegationPath: path,
        parentRunId,
        deliverTo,
      },
      hooks,
    )
      .catch(async (error: unknown) => {
        const cancelled = error instanceof RunCancelledError;
        const message = error instanceof Error ? error.message : String(error);
        if (!cancelled) {
          this.logger.error(`detached agent run ${runId} failed: ${message}`);
          publishAgentRunFailed({ runId, code: agentFailureCode(error), message });
        }
        await this.store.recordRunEnd?.({
          runId,
          status: cancelled ? 'cancelled' : 'failed',
          ...(cancelled ? {} : { errorCode: agentFailureCode(error), errorMessage: message }),
        });
        await Promise.resolve(
          this.store.failUnsettledToolCalls?.(runId, RUN_ENDED_BEFORE_TOOL_CALL),
        ).catch(() => 0);
        // The loop delivers its own success; a run that never produced an answer has to settle the
        // delegation itself, or the calling conversation shows "started" for ever.
        await settleUnsettledDelegation({
          store: this.store,
          delivery: deliverTo,
          agent: agentName,
          runId,
          status: cancelled ? 'cancelled' : 'failed',
          ...(cancelled ? {} : { error: message }),
        });
      })
      .finally(async () => {
        this.cancelled.delete(runId);
        await this.store.setActiveStream(subThread.id, null);
      });
    return { runId };
  }

  /**
   * Delegate to another agent as a nested in-process run. The sub-agent streams into `sinkRunId`
   * (the top-level run the human is watching) so its output and any pending action tool are visible,
   * and its own approvals resolve through the shared pending map keyed by its own runId.
   */
  private async runNested(args: {
    agentName: string;
    task: string;
    actor: Actor;
    day: string;
    depth: number;
    /** The chain that reached this child, root first. */
    path: readonly string[];
    sinkRunId: string;
    parentRunId: string;
  }): Promise<{ text: string }> {
    const { agentName, task, actor, day, depth, path, sinkRunId, parentRunId } = args;
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
      awaitApproval: (call, _ctx, opts) => this.parkApproval(runId, call.id, opts?.timeoutMs),
      awaitAnswers: (request) => this.park<ElicitationReply>(runId, request.id),
      step: (_name, fn) => fn(),
      parallel: settleAll,
      // A child stops when it is cancelled OR when the run a human is actually watching is: the
      // canceller names the top-level run, which is the only id that ever left the server.
      cancelled: async () => this.cancelled.has(runId) || this.cancelled.has(sinkRunId),
      runAgent: (childName, childTask) =>
        this.runNested({
          agentName: childName,
          task: childTask,
          actor,
          day,
          depth: depth + 1,
          path: [...path, agentName],
          sinkRunId,
          parentRunId: runId,
        }),
      startAgent: ({ agentName: childName, task: childTask, toolCallId }) =>
        this.startDetached({
          agentName: childName,
          task: childTask,
          actor,
          day,
          depth: depth + 1,
          path: [...path, agentName],
          parentRunId: runId,
          deliverTo: { threadId: subThread.id, toolCallId },
        }),
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
          delegationPath: path,
          parentRunId,
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

/**
 * A thread's own turn — not a sub-agent's run on a subthread, which neither holds its thread's
 * queue nor answers to it.
 */
function isThreadTurn(input: AgentRunInput): boolean {
  return input.sinkRunId === undefined && input.deliverTo === undefined;
}
