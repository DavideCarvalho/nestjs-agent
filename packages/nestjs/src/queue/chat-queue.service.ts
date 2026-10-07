import {
  AGENT_ATTACHMENT_STAGING,
  AGENT_DEPS_FACTORY,
  AGENT_OPTIONS,
  AGENT_QUOTA_PROVIDER,
  AGENT_SINK,
  AGENT_STORE,
  type Actor,
  type AgentRunInput,
  type AgentRunner,
  type AgentStore,
  type AgentStreamEvent,
  type AttachmentStagingStore,
  type ChatQueueState,
  type ChatQueueStore,
  type MessageAttachment,
  type QueuePause,
  type QueuePauseReason,
  type QueuedMessage,
  type QuotaProvider,
  type TokenStreamSink,
  encodeStreamEvent,
  isChatQueueStore,
  queuedMessageView,
} from '@dudousxd/nestjs-agent-core';
import { Inject, Injectable, Logger, NotImplementedException, Optional } from '@nestjs/common';
import type { AgentDepsFactory } from '../agent-deps.factory.js';
import { utcDay } from '../agent-deps.js';
import type { AgentModuleOptions } from '../agent.options.js';
import { publishQuotaBlocked } from '../quota-exceeded.js';
import { threadPersona } from '../thread-persona.js';

/** How the run that held a thread ended. */
export type QueueSettleOutcome = 'completed' | 'failed' | 'cancelled';

/** The next queued message a settling run handed the thread to — the caller starts it. */
export interface QueuedTurn {
  /** The run id the thread is already claimed for: the queued message's own id. */
  runId: string;
  input: AgentRunInput;
  messageId: string;
}

/**
 * What {@link ChatQueueService.plan} decided. Plain data, so a durable workflow can journal it in a
 * `localStep` and start `next` itself (`ctx.startChild`) — replay-safe, and never twice.
 */
export interface QueuePlan {
  next?: QueuedTurn;
  /** The `queue` frame to write into the settling run's stream, before its terminal. */
  frame?: AgentStreamEvent;
}

/** Starts a run under a pre-claimed id — a runner's own `start`, bound. */
export type QueuedTurnStarter = (input: AgentRunInput, runId: string) => Promise<unknown>;

/** How many times a drain retries when the head it picked is removed under it. */
const MAX_DRAIN_ATTEMPTS = 8;

/**
 * The thread-level message queue: messages a person sends while a turn is running wait here, and
 * the next one starts as soon as the running turn settles.
 *
 * Everything that decides WHICH run holds a thread goes through the store's compare-and-set
 * admission (`claimActiveStream` / `releaseActiveStream`), so two processes that both try to start
 * the next turn — a settling run on a worker and a send on an API pod — cannot both win. The next
 * run's id is the queued message's own id, which makes every step here idempotent: a retried claim
 * for the same message succeeds again, and a durable start under the same id is a no-op.
 *
 * Policy, per outcome of the run that held the thread:
 *  - `completed` → the head starts.
 *  - `failed`    → the queue pauses (`run_failed`), keeping every message.
 *  - `cancelled` → the queue pauses (`cancelled`), unless the head was queued by an interrupt — the
 *                  cancel was made for it, so it starts.
 * A paused queue starts nothing until it is resumed. A head whose actor is over quota pauses it
 * (`quota_exceeded`) instead of starting.
 */
@Injectable()
export class ChatQueueService {
  private readonly logger = new Logger(ChatQueueService.name);
  /**
   * Runs this process claimed a thread for and has not handed to a runner yet. A holder in here is
   * alive whatever the runner says — it simply has not registered the run yet.
   */
  private readonly starting = new Set<string>();

  constructor(
    @Inject(AGENT_STORE) private readonly store: AgentStore,
    @Inject(AGENT_SINK) private readonly sink: TokenStreamSink,
    @Optional()
    @Inject(AGENT_QUOTA_PROVIDER)
    private readonly quotaProvider?: QuotaProvider,
    @Optional()
    @Inject(AGENT_OPTIONS)
    private readonly options?: Pick<AgentModuleOptions, 'quota'>,
    @Optional()
    @Inject(AGENT_ATTACHMENT_STAGING)
    private readonly staging?: AttachmentStagingStore,
    // Optional: a queue built outside the module (a test, a host's own wiring) resolves no persona
    // for a message that did not carry one, which is how such a message always started.
    @Optional()
    @Inject(AGENT_DEPS_FACTORY)
    private readonly deps?: AgentDepsFactory,
  ) {}

  /** Whether the bound store can hold a queue. Without one, a busy thread is not queued. */
  get supported(): boolean {
    return isChatQueueStore(this.store);
  }

  /** The bound store as a queue store, or a 501 naming what is missing. */
  queueStore(): AgentStore & ChatQueueStore {
    if (!isChatQueueStore(this.store)) {
      throw new NotImplementedException(
        'Queueing messages requires an AgentStore that implements ChatQueueStore (enqueueMessage, ' +
          'listQueue, …, claimActiveStream, releaseActiveStream); the bound store does not.',
      );
    }
    return this.store;
  }

  async state(threadId: string): Promise<ChatQueueState> {
    const store = this.queueStore();
    const [items, paused] = await Promise.all([
      store.listQueue(threadId),
      store.queuePause(threadId),
    ]);
    return { items: items.map(queuedMessageView), paused };
  }

  /**
   * Whether `holder` is still running. A run this process is about to start is; otherwise the
   * runner decides, and a runner that cannot tell says yes.
   */
  async isAlive(holder: string, runner: AgentRunner): Promise<boolean> {
    if (this.starting.has(holder)) {
      return true;
    }
    if (typeof runner.isRunActive !== 'function') {
      return true;
    }
    try {
      return await runner.isRunActive(holder);
    } catch {
      return true;
    }
  }

  /**
   * The run holding `threadId`, or `null` when it is free — a holder the runner reports dead counts
   * as free, and is returned as `stale` so the caller can claim over it.
   */
  async holder(
    threadId: string,
    runner: AgentRunner,
  ): Promise<{ live: string | null; stale: string | null }> {
    const holder = await this.queueStore().activeRunForThread(threadId);
    if (holder === null) {
      return { live: null, stale: null };
    }
    return (await this.isAlive(holder, runner))
      ? { live: holder, stale: null }
      : { live: null, stale: holder };
  }

  /**
   * Decide what follows a TOP-LEVEL run that is settling on `threadId`, and move the thread there:
   * hand it to the next queued message (claimed and popped here, started by the caller), or pause
   * the queue, or release the thread. Call it BEFORE the run's terminal frame, so a client reading
   * the stream learns what comes next from the `queue` frame, and so the thread is already free
   * when the client sees the run end.
   *
   * A no-op returning `{}` on a store without a queue.
   */
  async plan(args: {
    threadId: string;
    /** The run that is settling; `null` when the thread is idle (a kick). */
    runId: string | null;
    outcome: QueueSettleOutcome;
    error?: string;
  }): Promise<QueuePlan> {
    if (!isChatQueueStore(this.store)) {
      return {};
    }
    const store = this.store;
    const { threadId, outcome } = args;
    // Only the run holding the thread moves it on. One that already handed it over (a durable
    // cancel settles from outside the body, and the body may still settle after it) has nothing
    // left to decide — deciding again would pause a queue the handover just started.
    if ((await store.activeRunForThread(threadId)) !== args.runId) {
      return {};
    }
    // The id holding the thread right now, as far as this drain knows: the settling run, until it
    // is released, then nobody.
    let holding: string | null = args.runId;
    for (let attempt = 0; attempt < MAX_DRAIN_ATTEMPTS; attempt += 1) {
      const items = await store.listQueue(threadId);
      const head = items[0];
      if (head === undefined) {
        if (holding !== null) {
          await store.releaseActiveStream(threadId, holding);
          holding = null;
          // An enqueue that landed between the read above and this release saw the thread held and
          // left its message for this drain — read once more now that the thread is free.
          continue;
        }
        return {};
      }
      let pause = await store.queuePause(threadId);
      if (pause === null) {
        const reason = pauseReasonFor(outcome, head);
        if (reason !== null) {
          pause = {
            reason,
            ...(outcome === 'failed' && args.error !== undefined ? { message: args.error } : {}),
            at: new Date().toISOString(),
          };
          await store.setQueuePause(threadId, pause);
        }
      }
      if (pause === null) {
        const blocked = await this.quotaBlock(head.actor);
        if (blocked !== null) {
          pause = { reason: 'quota_exceeded', message: blocked, at: new Date().toISOString() };
          await store.setQueuePause(threadId, pause);
        }
      }
      if (pause !== null) {
        if (holding !== null) {
          await store.releaseActiveStream(threadId, holding);
        }
        return { frame: queueFrame(items, pause) };
      }
      const claimed = await store.claimActiveStream(
        threadId,
        head.id,
        holding !== null ? { replacing: holding } : {},
      );
      if (!claimed) {
        // Someone else holds the thread now (a send that got in first); its own settle drains.
        return {};
      }
      holding = head.id;
      if (!(await store.removeQueuedMessage(head.id))) {
        // Removed (or started) under us between the read and the claim: give the claim back and
        // look at the new head.
        await store.releaseActiveStream(threadId, head.id);
        holding = null;
        continue;
      }
      const next: QueuedTurn = {
        runId: head.id,
        messageId: head.id,
        input: await this.inputFor(head),
      };
      return {
        next,
        frame: queueFrame(items.slice(1), null, { messageId: head.id, runId: head.id }),
      };
    }
    // Pathological churn (every head removed under us): leave the thread free rather than spin.
    if (holding !== null) {
      await store.releaseActiveStream(threadId, holding);
    }
    return {};
  }

  /**
   * {@link plan}, then start what it picked with `start`. What an in-process settle (the inline
   * runner, a durable cancel issued outside a workflow) calls; answers the frame to write.
   */
  async handoff(
    args: { threadId: string; runId: string; outcome: QueueSettleOutcome; error?: string },
    start: QueuedTurnStarter,
  ): Promise<AgentStreamEvent | undefined> {
    const plan = await this.plan(args);
    if (plan.next === undefined) {
      return plan.frame;
    }
    return (await this.launch(args.threadId, plan.next, start))
      ? plan.frame
      : this.pausedFrame(args.threadId);
  }

  /**
   * Start the head of an IDLE thread's queue — after a send queued behind a run that turned out to
   * be gone, after a resume, after a stale holder. Does nothing while a live run holds the thread
   * (its settle drains) or while the queue is paused. Answers the started run's id, if any.
   */
  async kick(threadId: string, runner: AgentRunner): Promise<string | undefined> {
    if (!isChatQueueStore(this.store)) {
      return undefined;
    }
    const { live, stale } = await this.holder(threadId, runner);
    if (live !== null) {
      return undefined;
    }
    if (stale !== null) {
      this.logger.warn(`thread ${threadId} was held by run ${stale}, which is no longer running`);
    }
    // Planned as if the stale holder completed: nothing it did pauses the queue.
    const plan = await this.plan({ threadId, runId: stale, outcome: 'completed' });
    if (plan.next === undefined) {
      return undefined;
    }
    const started = await this.launch(threadId, plan.next, (input, runId) =>
      runner.start(input, { runId }),
    );
    if (started && plan.frame !== undefined) {
      // The new run's own stream is where a client attached to nothing yet learns about it.
      await this.write(plan.next.runId, plan.frame);
    }
    return started ? plan.next.runId : undefined;
  }

  /**
   * Start a turn the thread is already claimed for. On failure the message goes back to the head of
   * the queue, the queue pauses (`start_failed`), and the claim is released — nothing is lost and
   * nothing is left holding the thread.
   */
  async launch(threadId: string, next: QueuedTurn, start: QueuedTurnStarter): Promise<boolean> {
    this.starting.add(next.runId);
    try {
      await start(next.input, next.runId);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`queued message ${next.messageId} could not start: ${message}`);
      await this.restore(threadId, next, 'start_failed', message);
      return false;
    } finally {
      this.starting.delete(next.runId);
    }
  }

  /** Put a turn that never started back at the head of its queue, paused, and free the thread. */
  async restore(
    threadId: string,
    next: QueuedTurn,
    reason: QueuePauseReason,
    message: string,
  ): Promise<void> {
    const store = this.queueStore();
    const { input } = next;
    await store.enqueueMessage({
      threadId,
      actor: input.actor,
      content: input.userText,
      at: 'head',
      ...(input.attachments !== undefined ? { attachments: input.attachments } : {}),
      ...(input.agentName !== undefined ? { agentName: input.agentName } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.pageContext !== undefined ? { pageContext: input.pageContext } : {}),
      ...(input.uiCapabilities !== undefined ? { uiCapabilities: input.uiCapabilities } : {}),
    });
    await store.setQueuePause(threadId, { reason, message, at: new Date().toISOString() });
    await store.releaseActiveStream(threadId, next.runId);
  }

  /** A `queue` frame with the thread's current state. */
  async pausedFrame(threadId: string): Promise<AgentStreamEvent> {
    return { kind: 'queue', queue: await this.state(threadId) };
  }

  /**
   * Tell whoever is watching the thread that its queue changed: a `queue` frame into the stream of
   * the run holding it. Best-effort — a thread nobody is streaming has no one to tell, and the next
   * read of the thread carries the queue anyway.
   */
  async publish(threadId: string): Promise<ChatQueueState> {
    const state = await this.state(threadId);
    const holder = await this.queueStore().activeRunForThread(threadId);
    if (holder !== null) {
      await this.write(holder, { kind: 'queue', queue: state }).catch((error: unknown) => {
        this.logger.warn(
          `could not publish the queue of thread ${threadId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }
    return state;
  }

  private async write(runId: string, frame: AgentStreamEvent): Promise<void> {
    const writer = await this.sink.open(runId);
    await writer.write(encodeStreamEvent(frame));
  }

  /** Why `actor` may not start a turn now (the quota message), or `null`. */
  async quotaBlock(actor: Actor): Promise<string | null> {
    if (this.options?.quota === undefined || this.quotaProvider === undefined) {
      return null;
    }
    try {
      const report = await this.quotaProvider.report({ actor });
      const { blocked } = report;
      if (blocked === undefined) {
        return null;
      }
      publishQuotaBlocked(actor, report, blocked);
      return (
        blocked.reason ?? `The ${blocked.period === 'day' ? 'daily' : 'monthly'} quota is used up`
      );
    } catch {
      // Failing to ask is not a verdict; the turn's own quota gate still runs.
      return null;
    }
  }

  /**
   * The turn a queued message starts: everything it was queued with, today's date, and its
   * attachments' urls minted afresh — the ones stored at enqueue time may have expired while it
   * waited. An attachment the staging store no longer resolves keeps its stored url.
   */
  private async inputFor(message: QueuedMessage): Promise<AgentRunInput> {
    const attachments = await this.freshAttachments(message.actor, message.attachments ?? []);
    const { agentName, persona } = await this.targetFor(message);
    return {
      threadId: message.threadId,
      actor: message.actor,
      userText: message.content,
      day: utcDay(),
      ...(agentName !== undefined ? { agentName } : {}),
      ...(persona !== undefined ? { persona } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(message.pageContext !== undefined ? { pageContext: message.pageContext } : {}),
      ...(message.uiCapabilities !== undefined ? { uiCapabilities: message.uiCapabilities } : {}),
      ...(message.model !== undefined ? { model: message.model } : {}),
    };
  }

  /**
   * The agent and persona a queued message starts as. A message carries the persona its send
   * resolved; one that carries none — queued before personas existed, or by a host that sets none —
   * resolves it now, exactly as a send would: an agent name a persona took over, then the thread's
   * pinned persona, then the agent's default. Never refused here: nobody is waiting on a 400.
   */
  private async targetFor(
    message: QueuedMessage,
  ): Promise<{ agentName?: string; persona?: string }> {
    const deps = this.deps;
    if (message.persona !== undefined || deps === undefined || message.agentName === undefined) {
      return {
        ...(message.agentName !== undefined ? { agentName: message.agentName } : {}),
        ...(message.persona !== undefined ? { persona: message.persona } : {}),
      };
    }
    const target = deps.resolveAgent(message.agentName);
    const hasPersonas = deps.personaCatalog(target.agentName).length > 0;
    const persona =
      target.persona ??
      (hasPersonas
        ? deps.resolvePersona({
            agentName: target.agentName,
            threadPersona: await threadPersona(this.store, message.threadId),
          })
        : undefined);
    return { agentName: target.agentName, ...(persona !== undefined ? { persona } : {}) };
  }

  private async freshAttachments(
    actor: Actor,
    attachments: MessageAttachment[],
  ): Promise<MessageAttachment[]> {
    const staging = this.staging;
    if (
      attachments.length === 0 ||
      staging === undefined ||
      typeof staging.resolve !== 'function'
    ) {
      return attachments;
    }
    return Promise.all(
      attachments.map(async (attachment) => {
        try {
          return (await staging.resolve({ mediaId: attachment.mediaId, actor })) ?? attachment;
        } catch {
          return attachment;
        }
      }),
    );
  }
}

/** The pause a settling run's outcome imposes on a non-empty queue, or `null` to keep draining. */
function pauseReasonFor(outcome: QueueSettleOutcome, head: QueuedMessage): QueuePauseReason | null {
  if (outcome === 'failed') {
    return 'run_failed';
  }
  if (outcome === 'cancelled' && head.interrupt !== true) {
    return 'cancelled';
  }
  return null;
}

function queueFrame(
  items: QueuedMessage[],
  paused: QueuePause | null,
  started?: { messageId: string; runId: string },
): AgentStreamEvent {
  return {
    kind: 'queue',
    queue: { items: items.map(queuedMessageView), paused },
    ...(started !== undefined ? { started } : {}),
  };
}
