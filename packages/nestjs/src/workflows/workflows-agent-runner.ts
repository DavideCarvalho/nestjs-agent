import { randomUUID } from 'node:crypto';
import {
  AGENT_SINK,
  AGENT_STORE,
  type AgentRunContext,
  type AgentRunInput,
  type AgentRunStartOptions,
  type AgentRunner,
  type AgentStore,
  type DetachedDelivery,
  type HumanReply,
  type TokenStreamSink,
  encodeStreamEvent,
  publishAgentRunCancelled,
  releaseThreadRun,
  settleUnsettledDelegation,
} from '@dudousxd/nestjs-agent-core';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  WorkflowClient,
  type WorkflowInstanceDetails,
  WorkflowNotFoundError,
  type WorkflowStatus,
} from '@nestjs/workflows';
import { utcDay } from '../agent-deps.js';
import { InProcessTokenStreamSink } from '../in-process-sink.js';
import type { ChatQueueService } from '../queue/chat-queue.service.js';
import { AGENT_CHAT_QUEUE } from '../queue/chat-queue.token.js';
import { AGENT_REPLY, type PendingReply, replyKey } from './agent-reply.signal.js';
import { AgentRunFlow } from './agent-run.flow.js';

const ENDED: ReadonlySet<WorkflowStatus> = new Set([
  'completed',
  'failed',
  'cancelled',
  'compensation_failed',
]);

/** The fields of a recorded `AgentRunInput` this runner reads back, structurally. */
interface RecordedInput {
  threadId?: unknown;
  sinkRunId?: unknown;
  deliverTo?: unknown;
  agentName?: unknown;
  parentRunId?: unknown;
  actor?: { id?: unknown; tenantRef?: unknown };
}

function recorded(input: unknown): RecordedInput {
  return typeof input === 'object' && input !== null ? (input as RecordedInput) : {};
}

function deliveryOf(input: unknown): { delivery: DetachedDelivery; agent: string } | undefined {
  const { deliverTo, agentName } = recorded(input);
  if (
    typeof deliverTo !== 'object' ||
    deliverTo === null ||
    typeof (deliverTo as { threadId?: unknown }).threadId !== 'string' ||
    typeof (deliverTo as { toolCallId?: unknown }).toolCallId !== 'string'
  ) {
    return undefined;
  }
  return {
    delivery: deliverTo as DetachedDelivery,
    agent: typeof agentName === 'string' ? agentName : 'default',
  };
}

function runContextOf(input: unknown): AgentRunContext | undefined {
  const { actor, agentName, parentRunId } = recorded(input);
  if (typeof actor?.id !== 'string') return undefined;
  return {
    actorId: actor.id,
    ...(typeof agentName === 'string' ? { agentName } : {}),
    ...(typeof actor.tenantRef === 'string' ? { tenantRef: actor.tenantRef } : {}),
    ...(typeof parentRunId === 'string' ? { parentRunId } : {}),
  };
}

/**
 * Runs agent turns on NestJS's `@nestjs/workflows` (`durable: true`). `start` creates the
 * `aviary.agent.run` instance under the run id and returns; whichever worker claims it runs the turn
 * and streams to the sink. A person's reply to a parked call is the `AGENT_REPLY` signal keyed by
 * `<runId>:<toolCallId>`; a Stop is `WorkflowClient.cancel`.
 */
@Injectable()
export class WorkflowsAgentRunner implements AgentRunner {
  private readonly logger = new Logger(WorkflowsAgentRunner.name);
  private readonly client: WorkflowClient;

  constructor(
    @Inject(AGENT_STORE) private readonly store: AgentStore,
    @Inject(AGENT_SINK) private readonly sink: TokenStreamSink,
    @Optional() client?: WorkflowClient,
    @Optional() @Inject(AGENT_CHAT_QUEUE) private readonly queue?: ChatQueueService,
  ) {
    if (client === undefined) {
      throw new Error(
        "AgentWorkflowsModule runs turns on @nestjs/workflows: import WorkflowsModule.forRoot() from '@nestjs/workflows' " +
          '(WorkflowsModule.forRoot({ worker: false }) on a process that must not run turns, such as an API pod). ' +
          'No WorkflowClient was found.',
      );
    }
    this.client = client;
    if (this.sink instanceof InProcessTokenStreamSink) {
      this.logger.warn(
        'durable turns with the default InProcessTokenStreamSink, which only buffers tokens in this process: ' +
          'fine while this process runs the workflow worker, but a turn claimed by another process cannot stream ' +
          'to this one. Wire a cross-process TokenStreamSink (e.g. the Redis one) before running several processes.',
      );
    }
  }

  async start(
    input: AgentRunInput,
    options: AgentRunStartOptions = {},
  ): Promise<{ runId: string }> {
    const stamped: AgentRunInput = { ...input, day: input.day ?? utcDay() };
    const runId = options.runId ?? randomUUID();
    await this.client.start(AgentRunFlow, stamped, { id: runId });
    return { runId };
  }

  /** Not ended as far as the engine knows. An unknown run counts as running, and so does one it can't be asked about. */
  async isRunActive(runId: string): Promise<boolean> {
    try {
      const status = (await this.client.getStatus(runId))?.status;
      return status === undefined || !ENDED.has(status);
    } catch {
      return true;
    }
  }

  async signal(runId: string, toolCallId: string, reply: HumanReply): Promise<void> {
    const key = replyKey(runId, toolCallId);
    // The first reply to a call counts: a repeat is stored once and never seen.
    await this.client.signal(AGENT_REPLY, reply, { key, id: key });
  }

  /** The engine's view of a run: status, custom status, waits, children. `null` for an unknown id. */
  getStatus(runId: string): Promise<WorkflowInstanceDetails | null> {
    return this.client.getStatus(runId, { children: true });
  }

  /**
   * The calls of run `runId` waiting for a person now, in the instance it started in, in the
   * instances it went on in, and in the sub-agent runs it delegated to.
   */
  async pendingReplies(runId: string): Promise<PendingReply[]> {
    const found: PendingReply[] = [];
    const visit = async (id: string): Promise<void> => {
      const details = await this.client.getStatus(id, { children: true });
      if (details === null) return;
      const status = details.customStatus as { pendingReplies?: PendingReply[] } | null;
      found.push(...(status?.pendingReplies ?? []));
      for (const child of details.children ?? []) {
        // A detached run is a run of its own: it lists its calls under its own id.
        if (!ENDED.has(child.status) && child.parentClose !== 'abandon') await visit(child.id);
      }
    };
    await visit(runId);
    return found;
  }

  /**
   * Stop a run: the engine stops the turn at its next `ctx` call (a parked turn at once), and
   * cancels the sub-agent runs it is waiting on. What the engine knows nothing about is settled
   * here, as on the `aviary` engine: the delegation a detached run answers, the thread's queue and
   * live stream, the subscriber's stream (a `cancelled` frame and a normal end), the run's row.
   */
  async cancel(runId: string): Promise<void> {
    this.logger.log(`cancelling agent run ${runId}`);
    const details = await this.client.getStatus(runId).catch(() => null);
    const input = details?.input;
    const { threadId, sinkRunId, deliverTo } = recorded(input);
    try {
      await this.client.cancel(runId, 'Stopped');
    } catch (error) {
      if (!(error instanceof WorkflowNotFoundError)) throw error;
    }
    const target = deliveryOf(input);
    if (target !== undefined) {
      await settleUnsettledDelegation({
        store: this.store,
        delivery: target.delivery,
        agent: target.agent,
        runId,
        status: 'cancelled',
      }).catch((error: unknown) =>
        this.logger.error(
          `could not settle the delegation of cancelled run ${runId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      );
    }
    const writer = await this.sink.open(runId);
    if (typeof threadId === 'string') {
      const threadTurn = sinkRunId === undefined && deliverTo === undefined;
      if (this.queue?.supported === true && threadTurn) {
        try {
          const frame = await this.queue.handoff(
            { threadId, runId, outcome: 'cancelled' },
            (next, nextRunId) => this.start(next, { runId: nextRunId }),
          );
          if (frame !== undefined) await writer.write(encodeStreamEvent(frame));
        } catch (error) {
          this.logger.error(
            `could not advance the queue of thread ${threadId} after cancelling ${runId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      await releaseThreadRun(this.store, threadId, runId);
    }
    await writer.write(encodeStreamEvent({ kind: 'cancelled' }));
    await writer.end();
    const durationMs =
      details !== null && details !== undefined
        ? Math.max(0, details.updatedAt - details.createdAt)
        : undefined;
    const context = runContextOf(input);
    publishAgentRunCancelled({
      runId,
      ...(typeof threadId === 'string' ? { threadId } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(context !== undefined ? { context } : {}),
    });
    await this.store.recordRunEnd?.({
      runId,
      status: 'cancelled',
      ...(durationMs !== undefined ? { durationMs } : {}),
    });
  }
}
