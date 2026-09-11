import {
  AGENT_ATTACHMENT_STAGING,
  AGENT_DEPS_FACTORY,
  AGENT_QUOTA_STORE,
  AGENT_RUNNER,
  AGENT_STORE,
  type Actor,
  type AgentRunInput,
  type AgentRunner,
  type AgentStore,
  type AttachmentRef,
  type AttachmentStagingStore,
  type Decision,
  type ElicitationReply,
  type HumanReply,
  type ListStagedAttachmentsInput,
  type MessageAttachment,
  type PageContext,
  type QuotaStore,
  type QuotaView,
  type StagedAttachment,
  type ThreadDetail,
  type ThreadSummary,
  type UpdateThreadInput,
} from '@dudousxd/nestjs-agent-core';
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  NotImplementedException,
  Optional,
} from '@nestjs/common';
import type { AgentDepsFactory } from './agent-deps.factory.js';
import { utcDay } from './agent-deps.js';

export interface ChatParams {
  actor: Actor;
  message: string;
  threadId?: string;
  agentName?: string;
  /**
   * Files attached to this message (image/PDF) for a vision-capable model, named by the `mediaId`
   * the upload returned. Only the id is read: the url, content type and name are resolved from the
   * bound {@link AttachmentStagingStore}, so nothing a caller says decides what the model fetches.
   */
  attachments?: AttachmentRef[];
  pageContext?: PageContext;
  /** Re-run the last exchange instead of adding a new message. Requires an existing `threadId`. */
  regenerate?: boolean;
  /**
   * When creating a thread (no `threadId`), start it transient — a scratch conversation hidden from
   * the thread list until the caller promotes it. Ignored when `threadId` is set.
   */
  transient?: boolean;
}

/**
 * A store that can answer a thread's default agent on its own, without materializing the thread.
 *
 * Probed STRUCTURALLY rather than declared on `AgentStore`: the projection is an optimization a
 * store either offers or doesn't, and a store that predates it still answers correctly through
 * `getThread`. Every adapter in this repo implements it.
 */
export interface ThreadDefaultAgentReader {
  defaultAgentForThread(threadId: string): Promise<string | null>;
}

/** The orchestration facade the controllers call. */
@Injectable()
export class AgentService {
  constructor(
    @Inject(AGENT_RUNNER) private readonly runner: AgentRunner,
    @Inject(AGENT_STORE) private readonly store: AgentStore,
    @Inject(AGENT_DEPS_FACTORY) private readonly deps: AgentDepsFactory,
    @Inject(AGENT_QUOTA_STORE) private readonly quota: QuotaStore | undefined,
    @Optional()
    @Inject(AGENT_ATTACHMENT_STAGING)
    private readonly staging?: AttachmentStagingStore,
  ) {}

  async chat(params: ChatParams): Promise<{ runId: string; threadId: string }> {
    // Precedence: explicit agentName > the thread's own defaultAgent (set via updateThread) > the
    // module's configured default. Resolved up front (before thread creation) so a brand-new thread
    // — which has no defaultAgent yet — falls straight through to the module default.
    const agentName = await this.resolveAgentName(params.agentName, params.threadId);
    // Before the thread exists, so a turn that names an attachment it may not have leaves nothing
    // behind.
    const attachments = await this.resolveAttachments(params.actor, params.attachments ?? []);
    let threadId = params.threadId;
    if (threadId === undefined) {
      if (params.regenerate === true) {
        throw new BadRequestException('regenerate requires an existing threadId');
      }
      const created = await this.store.createThread({
        actor: params.actor,
        ...(params.transient === true ? { transient: true } : {}),
      });
      threadId = created.id;
    } else if (params.regenerate === true) {
      // Regenerate re-runs a run on an existing thread — gate it by ownership like the other
      // thread-scoped actions so one actor can't rewind another's conversation.
      await this.assertOwnsThread(params.actor, threadId);
    }

    const input: AgentRunInput = {
      threadId,
      actor: params.actor,
      userText: params.message,
      day: utcDay(),
      agentName,
      ...(params.regenerate === true ? { regenerate: true } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(params.pageContext !== undefined ? { pageContext: params.pageContext } : {}),
    };

    const { runId } = await this.runner.start(input);
    await this.store.setActiveStream(threadId, runId);
    return { runId, threadId };
  }

  /**
   * Rebuild this turn's attachments from the staging store, keyed by the ids the caller claimed.
   * The model provider fetches {@link MessageAttachment.url} verbatim, so that url is only ever
   * allowed to come from the host's own store — a caller that could name it could point the server
   * at anything it can reach (cloud metadata, internal services) and read the response back out of
   * the model's answer.
   *
   * No store bound means no way to tell an id the actor owns from one they don't, so a turn simply
   * cannot carry attachments: 501 rather than trusting the request.
   */
  private async resolveAttachments(
    actor: Actor,
    refs: AttachmentRef[],
  ): Promise<MessageAttachment[]> {
    if (refs.length === 0) {
      return [];
    }
    const staging = this.staging;
    if (staging === undefined || typeof staging.resolve !== 'function') {
      throw new NotImplementedException(
        'Message attachments require an AGENT_ATTACHMENT_STAGING provider implementing resolve(); ' +
          'attachment urls are never taken from the request.',
      );
    }
    const resolved: MessageAttachment[] = [];
    for (const ref of refs) {
      const attachment = await staging.resolve({ mediaId: ref.mediaId, actor });
      if (attachment === null) {
        throw new ForbiddenException(`attachment ${ref.mediaId} is not available to this actor`);
      }
      resolved.push(attachment);
    }
    return resolved;
  }

  /**
   * The run's live token stream, WITHOUT an ownership check — for in-process callers that are
   * already authorized (the MCP bridge, a host's own job code), the same split as
   * {@link signalToolCall} vs {@link approve}. Anything reachable from a request must go through
   * {@link subscribeAs} instead: a runId is the only thing standing between a caller and another
   * actor's answer, tool arguments and tool results.
   */
  subscribe(runId: string): AsyncIterable<Uint8Array> {
    return this.deps.forAgent().sink.subscribe(runId);
  }

  /**
   * {@link subscribe}, gated the way {@link cancel} is: only the actor whose thread is currently
   * streaming this run may read it. A run that has already finished is reported missing rather than
   * replayed — the runner clears the thread's active stream as the run ends, and that field is what
   * ownership is derived from.
   */
  async subscribeAs(actor: Actor, runId: string): Promise<AsyncIterable<Uint8Array>> {
    await this.assertOwnsActiveStream(actor, runId);
    return this.subscribe(runId);
  }

  async approve(actor: Actor, toolCallId: string): Promise<void> {
    await this.assertOwnsToolCall(actor, toolCallId);
    return this.signalToolCall(toolCallId, { approved: true });
  }

  async reject(actor: Actor, toolCallId: string, reason?: string): Promise<void> {
    await this.assertOwnsToolCall(actor, toolCallId);
    return this.signalToolCall(toolCallId, {
      approved: false,
      ...(reason !== undefined ? { reason } : {}),
    });
  }

  /**
   * Answer a parked question set. An omitted question takes the request's own pre-picked default —
   * resolved by the LOOP against the request it already holds, so "the user just submitted" and
   * "the user picked exactly the defaults" persist as the same answers, and no client has to
   * re-send what it was shown.
   */
  async answer(
    actor: Actor,
    toolCallId: string,
    answers: Record<string, string[]> = {},
  ): Promise<void> {
    await this.assertOwnsToolCall(actor, toolCallId);
    const reply: ElicitationReply = { answers, answeredByRef: actor.id };
    return this.signalToolCall(toolCallId, reply);
  }

  /**
   * Decline to answer and let the agent proceed on its own assumptions. NOT the same as confirming
   * them: the run records this as a rejection, so a reader auditing what the agent was told can
   * tell a choice the user made from one they refused to make.
   */
  async skip(actor: Actor, toolCallId: string): Promise<void> {
    await this.assertOwnsToolCall(actor, toolCallId);
    const reply: ElicitationReply = { answers: {}, skipped: true, answeredByRef: actor.id };
    return this.signalToolCall(toolCallId, reply);
  }

  /**
   * The decision core behind approve/reject, WITHOUT an ownership check: resolves the run
   * currently awaiting `toolCallId` and signals it. `approve`/`reject` above call this after their
   * own `assertOwnsToolCall` gate; the console `AgentApprovalPort` adapter (bound by `AgentModule`)
   * calls it directly — a console caller is already authorized by the dashboard's own guards, and
   * re-deriving thread ownership here would reject a legitimate operator decision (an operator is
   * not the thread's own actor).
   */
  async signalToolCall(toolCallId: string, reply: HumanReply): Promise<void> {
    const runId = await this.resolveRunForToolCall(toolCallId);
    return this.runner.signal(runId, toolCallId, reply);
  }

  async cancel(actor: Actor, runId: string): Promise<void> {
    await this.assertOwnsActiveStream(actor, runId);
    return this.runner.cancel(runId);
  }

  async listThreads(actorRef: string): Promise<ThreadSummary[]> {
    const threads = await this.store.listThreads(actorRef);
    return Promise.all(threads.map((thread) => this.toSummaryView(thread)));
  }

  async getThread(actor: Actor, threadId: string): Promise<ThreadDetail | null> {
    await this.assertOwnsThread(actor, threadId);
    const thread = await this.store.getThread(threadId);
    return thread === null ? null : this.toDetailView(thread);
  }

  async deleteThread(actor: Actor, threadId: string): Promise<void> {
    await this.assertOwnsThread(actor, threadId);
    return this.store.softDeleteThread(threadId);
  }

  async forkThread(actor: Actor, threadId: string, fromMessageId: string): Promise<ThreadSummary> {
    await this.assertOwnsThread(actor, threadId);
    return this.store.forkThread(threadId, fromMessageId);
  }

  /** Kept for source compatibility — a thin wrapper over the more general `updateThread`. */
  async renameThread(actor: Actor, threadId: string, title: string): Promise<void> {
    return this.updateThread(actor, threadId, { title });
  }

  /**
   * Rename a thread and/or set its default agent. Title-only patches work against ANY store (via
   * the required `setTitle`); a `defaultAgent` change requires the bound store to implement the
   * optional `updateThread` — 501 with a clear message when it doesn't, rather than silently
   * dropping the field.
   */
  async updateThread(actor: Actor, threadId: string, patch: UpdateThreadInput): Promise<void> {
    const title = patch.title !== undefined ? this.validateTitle(patch.title) : undefined;
    await this.assertOwnsThread(actor, threadId);
    if (patch.defaultAgent === undefined) {
      if (title !== undefined) {
        await this.store.setTitle(threadId, title);
      }
      return;
    }
    if (this.store.updateThread === undefined) {
      throw new NotImplementedException(
        "Setting a thread's defaultAgent requires an AgentStore that implements updateThread(); " +
          'the bound store does not support it.',
      );
    }
    await this.store.updateThread(threadId, {
      ...(title !== undefined ? { title } : {}),
      defaultAgent: patch.defaultAgent,
    });
  }

  private validateTitle(title: string): string {
    const trimmed = title.trim();
    if (trimmed.length === 0) {
      throw new BadRequestException('title must not be empty');
    }
    if (trimmed.length > 200) {
      throw new BadRequestException('title must be at most 200 characters');
    }
    return trimmed;
  }

  /**
   * Agent-selection precedence for a `chat()` call with no explicit `agentName`: the thread's own
   * `defaultAgent` (if the thread exists and one is set) wins over the module's configured default.
   * Skips the store entirely when the caller already named an agent or there's no thread yet.
   *
   * What this needs is one nullable scalar, so it asks for one. `getThread` returns the entire
   * transcript — every message, every persisted tool output — and this discards all of it; on a
   * long thread with large tool results that is hundreds of kilobytes read per turn, outside the
   * workflow, for a string. A store predating {@link ThreadDefaultAgentReader} still answers, via
   * the full read.
   */
  private async resolveAgentName(
    agentName: string | undefined,
    threadId: string | undefined,
  ): Promise<string> {
    if (agentName !== undefined) {
      return agentName;
    }
    if (threadId !== undefined) {
      const threadDefault = await this.threadDefaultAgent(threadId);
      if (threadDefault !== null) {
        return threadDefault;
      }
    }
    return this.deps.defaultAgentName();
  }

  private async threadDefaultAgent(threadId: string): Promise<string | null> {
    const projecting = this.store as Partial<ThreadDefaultAgentReader>;
    if (typeof projecting.defaultAgentForThread === 'function') {
      return projecting.defaultAgentForThread(threadId);
    }
    return (await this.store.getThread(threadId))?.defaultAgent ?? null;
  }

  private async toSummaryView(thread: ThreadSummary): Promise<ThreadSummary> {
    return {
      ...thread,
      defaultAgent: thread.defaultAgent ?? null,
      activeRunId: (await this.store.activeRunForThread?.(thread.id)) ?? null,
    };
  }

  private async toDetailView(thread: ThreadDetail): Promise<ThreadDetail> {
    const summary = await this.toSummaryView(thread);
    return {
      ...summary,
      messages: thread.messages,
      ...(thread.activeStreamId !== undefined ? { activeStreamId: thread.activeStreamId } : {}),
    };
  }

  async promoteThread(actor: Actor, threadId: string): Promise<void> {
    await this.assertOwnsThread(actor, threadId);
    return this.store.promoteThread(threadId);
  }

  /**
   * Drop a message and everything after it — the "edit and resend" / "delete from here" primitive.
   * The client then sends a fresh turn on the truncated thread. Ownership-gated like the other
   * thread-scoped mutations.
   */
  async truncateThreadFrom(actor: Actor, threadId: string, messageId: string): Promise<void> {
    await this.assertOwnsThread(actor, threadId);
    return this.store.truncateFrom(threadId, messageId);
  }

  /**
   * Every file this actor has staged, newest first — across threads, including uploads that were
   * never sent, which nothing else on this surface can see.
   *
   * Metadata only. A url is minted per turn by `resolve` so it can be short-lived, and handing one
   * back per entry would undo that for the price of rendering a list.
   */
  async listAttachments(
    actor: Actor,
    options: { limit?: number } = {},
  ): Promise<StagedAttachment[]> {
    const list = this.attachmentInventory();
    return list({ actor, ...(options.limit !== undefined ? { limit: options.limit } : {}) });
  }

  /**
   * This actor's staged media that no live message references and that is old enough not to be an
   * upload in flight — the candidate set for a sweep. Returns them; never deletes them. The bytes
   * are the host's, and so is the decision.
   *
   * `olderThan` is required and has no default. How long a composer may sit open with a file
   * attached is the host's knowledge, and a library-chosen grace period would eventually delete a
   * file someone was about to send. The staging store is asked to apply it, and the result is
   * filtered again here: a store that ignores the hint would otherwise turn this into exactly that
   * bug, silently.
   *
   * Both halves must be answerable or this refuses. An unanswerable reference query means "cannot
   * tell", and treating it as "nothing is referenced" would hand back every attachment the actor
   * ever sent, marked safe to delete.
   */
  async collectableAttachments(
    actor: Actor,
    options: { olderThan: Date; limit?: number },
  ): Promise<StagedAttachment[]> {
    const list = this.attachmentInventory();
    const referencedMediaIds = this.store.referencedMediaIds?.bind(this.store);
    if (referencedMediaIds === undefined) {
      throw new NotImplementedException(
        'Collecting attachments requires an AgentStore that implements referencedMediaIds(); the ' +
          'bound store cannot say which media a message still references, and guessing would ' +
          'delete files that are in use.',
      );
    }
    const stagedBefore = options.olderThan.toISOString();
    const inventory = await list({
      actor,
      stagedBefore,
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
    });
    const aged = inventory.filter((entry) => entry.createdAt < stagedBefore);
    const referenced = new Set(
      await referencedMediaIds(
        actor.id,
        aged.map((entry) => entry.mediaId),
      ),
    );
    return aged.filter((entry) => !referenced.has(entry.mediaId));
  }

  /**
   * The bound staging store's `list`, or a refusal. Absence is never answered with an empty list:
   * "this host keeps no inventory" and "this actor has no files" are opposite facts that would
   * otherwise render identically — as a clean file list, and as a sweep that collects nothing.
   */
  private attachmentInventory(): (
    input: ListStagedAttachmentsInput,
  ) => Promise<StagedAttachment[]> {
    const list = this.staging?.list?.bind(this.staging);
    if (list === undefined) {
      throw new NotImplementedException(
        'Listing attachments requires an AGENT_ATTACHMENT_STAGING provider implementing list(); ' +
          'the host owns the staged bytes, so only it can enumerate them.',
      );
    }
    return list;
  }

  /**
   * The day's usage for the badge: tokens + summed USD cost from the store, and the configured
   * limit from the quota store (null → unlimited). `withinLimit` comes from the quota store so it
   * can never drift from what enforcement uses.
   */
  async quotaToday(actorRef: string): Promise<QuotaView> {
    const day = utcDay();
    const { usedTokens, costUsd } = await this.store.quotaToday(actorRef, day);
    if (this.quota === undefined) {
      return { usedTokens, costUsd, limitTokens: null, withinLimit: true };
    }
    const state = await this.quota.check(actorRef, day);
    return {
      usedTokens: state.usedTokens,
      costUsd,
      limitTokens: state.limitTokens,
      withinLimit: state.withinLimit,
    };
  }

  /**
   * Authorization seam for thread-scoped endpoints: the caller must own the thread. A missing
   * thread is a 404; someone else's thread is a 403 — one actor never touches another's thread.
   */
  private async assertOwnsThread(actor: Actor, threadId: string): Promise<void> {
    const owner = await this.store.ownerOfThread(threadId);
    if (owner === null) {
      throw new NotFoundException(`thread ${threadId} not found`);
    }
    if (owner !== actor.id) {
      throw new ForbiddenException('thread belongs to another actor');
    }
  }

  /**
   * Authorization seam for HITL approve/reject: the caller must own the tool call's thread. Split
   * out from run resolution (see {@link resolveRunForToolCall}) so the console `AgentApprovalPort`
   * adapter can resolve+signal a decision WITHOUT this check — it is authorized upstream instead.
   */
  private async assertOwnsToolCall(actor: Actor, toolCallId: string): Promise<void> {
    const owner = await this.store.ownerOfToolCall(toolCallId);
    if (owner === null) {
      throw new NotFoundException(`tool call ${toolCallId} not found`);
    }
    if (owner !== actor.id) {
      throw new ForbiddenException('tool call belongs to another actor');
    }
  }

  /**
   * Resolve the run awaiting `toolCallId`. Derived server-side from the tool call alone — the client
   * never knows or supplies a runId, and that run is the sub-agent's own child run when the pending
   * call belongs to a delegated agent. The store answers from the CALL'S OWN `runId` where it has
   * one; see `AgentStore.runForToolCall` for why that matters once a thread can hold more than one
   * live run.
   */
  private async resolveRunForToolCall(toolCallId: string): Promise<string> {
    const runId = await this.store.runForToolCall(toolCallId);
    if (runId === null) {
      throw new NotFoundException(`tool call ${toolCallId} has no active run to signal`);
    }
    return runId;
  }

  /** Authorization seam for `cancel`: the caller must own the thread currently streaming this run. */
  private async assertOwnsActiveStream(actor: Actor, runId: string): Promise<void> {
    const owner = await this.store.ownerOfActiveStream(runId);
    if (owner === null) {
      throw new NotFoundException(`no active run ${runId}`);
    }
    if (owner !== actor.id) {
      throw new ForbiddenException('run belongs to another actor');
    }
  }
}
