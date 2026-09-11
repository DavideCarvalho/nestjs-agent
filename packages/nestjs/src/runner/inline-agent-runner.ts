import {
  AGENT_DEPS_FACTORY,
  AGENT_STORE,
  type Actor,
  type AgentLoopHooks,
  type AgentRunInput,
  type AgentRunner,
  type AgentStore,
  type Decision,
  type ElicitationReply,
  type HumanReply,
  RunCancelledError,
  agentFailureCode,
  encodeStreamEvent,
  publishAgentRunFailed,
  runAgentLoop,
  settleAll,
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
        if (error instanceof RunCancelledError) {
          await this.settleCancelled(runId, input.threadId, deps);
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
        // Clear the thread's active run — a failed run isn't "still running" for `activeRunForThread`.
        await this.store.setActiveStream(input.threadId, null);
        // Terminate the live stream with a typed failure so the transport emits an error frame
        // instead of leaking the message as assistant text.
        const writer = await deps.sink.open(runId);
        await writer.fail({ code, message });
      })
      .finally(() => this.cancelled.delete(runId));

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
  private async settleCancelled(runId: string, threadId: string, deps: AgentDeps): Promise<void> {
    this.logger.log(`agent run ${runId} cancelled`);
    await this.store.setActiveStream(threadId, null);
    const writer = await deps.sink.open(runId);
    await writer.write(encodeStreamEvent({ kind: 'cancelled' }));
    await writer.end();
    // Last, so the reader is released before the bookkeeping: everything above is what someone is
    // waiting on, and the run row is what someone reads afterwards.
    await this.store.recordRunEnd?.({ runId, status: 'cancelled' });
  }

  /**
   * Park a run on a human, keyed by run + tool call. One map for approvals and for question-set
   * answers alike: both wait on the same key, and `signal` cannot tell (or need to tell) which
   * shape it is delivering — the loop asked for one and only ever gets what the caller sent. A
   * cancel settles the wait too, by rejecting it.
   */
  private park<T extends HumanReply>(runId: string, toolCallId: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.set(`${runId}:${toolCallId}`, {
        resolve: resolve as (reply: HumanReply) => void,
        reject,
      });
    });
  }

  private topLevelHooks(runId: string, deps: AgentDeps, actor: Actor, day: string): AgentLoopHooks {
    return {
      runId,
      openSink: () => deps.sink.open(runId),
      awaitApproval: (call) => this.park<Decision>(runId, call.id),
      awaitAnswers: (request) => this.park<ElicitationReply>(runId, request.id),
      step: (_name, fn) => fn(),
      parallel: settleAll,
      cancelled: async () => this.cancelled.has(runId),
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
      awaitApproval: (call) => this.park<Decision>(runId, call.id),
      awaitAnswers: (request) => this.park<ElicitationReply>(runId, request.id),
      step: (_name, fn) => fn(),
      parallel: settleAll,
      // A child stops when it is cancelled OR when the run a human is actually watching is: the
      // canceller names the top-level run, which is the only id that ever left the server.
      cancelled: async () => this.cancelled.has(runId) || this.cancelled.has(sinkRunId),
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
