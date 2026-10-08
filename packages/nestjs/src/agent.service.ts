import {
  AGENT_ATTACHMENT_STAGING,
  AGENT_DEPS_FACTORY,
  AGENT_MODEL_CATALOG,
  AGENT_OPTIONS,
  AGENT_QUOTA_PROVIDER,
  AGENT_RUNNER,
  AGENT_STORE,
  type ActionApprovalMode,
  type ActionProposalMutationView,
  type ActionProposalView,
  type Actor,
  type AgentHostContext,
  type AgentRunInput,
  type AgentRunner,
  type AgentStore,
  type AttachmentRef,
  type AttachmentStagingStore,
  type ChatQueueState,
  DEFAULT_TEXT_ACTION_PROPOSAL_VOCABULARY,
  type Decision,
  type ElicitationReply,
  type HumanReply,
  type ListStagedAttachmentsInput,
  type MessageAttachment,
  type MessageFeedback,
  type MessageFeedbackValue,
  type ModelCatalog,
  type ModelCatalogView,
  type PageContext,
  type QuotaProvider,
  type QuotaReport,
  REQUESTER_APPROVER,
  type StagedAttachment,
  type StoredMessage,
  type TextActionProposalVocabulary,
  type ThreadDetail,
  type ThreadSummary,
  type UpdateThreadInput,
  findCatalogModel,
  mayDecideApproval,
  readElicitationQuestions,
  settleDeadRun,
  textActionProposalReply,
  validateElicitationAnswer,
} from '@dudousxd/nestjs-agent-core';
import type { UiCapabilities } from '@dudousxd/nestjs-agent-core/genui';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
  NotImplementedException,
  Optional,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import type { AgentDepsFactory } from './agent-deps.factory.js';
import { utcDay } from './agent-deps.js';
import type { AgentModuleOptions } from './agent.options.js';
import { type AttachmentLimits, attachmentLimits } from './attachment-limits.js';
import { ActionProposalService } from './proposals/action-proposal.service.js';
import { ChatQueueService } from './queue/chat-queue.service.js';
import { publishQuotaBlocked } from './quota-exceeded.js';
import { RunNotActiveException } from './run-not-active.exception.js';
import { threadPersona } from './thread-persona.js';

/**
 * What a send does when its thread already has a turn running:
 *  - `'auto'` (default) — run now when the thread is idle, else wait in the thread's queue.
 *  - `'queue'` — always wait in the queue, behind whatever is already waiting (it still starts at
 *    once when nothing is running and nothing is ahead of it).
 *  - `'interrupt'` — cancel the running turn and run this one next, ahead of the queue.
 */
export type ChatSendMode = 'auto' | 'queue' | 'interrupt';

/** A send that is waiting in its thread's queue instead of running. */
export interface QueuedSend {
  threadId: string;
  queued: true;
  /** The queued message's id — also the run id it will start under. */
  messageId: string;
  /** 0-based place in the queue at the time it was queued (`0` → next). */
  position: number;
  queue: ChatQueueState;
  /** The turn it started under, when it started straight away (an idle thread). */
  runId?: string;
  /** The run an interrupt cancelled to make room for it. */
  interrupting?: string;
}

/** What {@link AgentService.send} did: started a turn, or queued the message. */
export type ChatSendResult =
  | { runId: string; threadId: string; queued?: undefined }
  | QueuedSend
  | { threadId: string; proposalDecision: unknown; text: string; queued?: undefined };

export interface ChatParams {
  uiCapabilities?: UiCapabilities;
  actor: Actor;
  message: string;
  /** The host's own facts about this send — see `AgentRunInput.hostContext`. */
  hostContext?: AgentHostContext;
  /**
   * The HOST already decided this actor may write this thread — a chat-app thread several people
   * share, where anyone in it may continue the conversation. Skips the thread-ownership check of a
   * send; never set it from a request's own claim.
   */
  authorized?: boolean;
  threadId?: string;
  agentName?: string;
  /**
   * Run this turn under one of the agent's personas (`@Agent({ personas })`), and pin it on the
   * thread so later sends that name none keep it. Refused (400 `persona_not_found`) unless the agent
   * declares it. Omitted → the thread's pinned persona, else the agent's `defaultPersona`, else none.
   */
  personaId?: string;
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
   * Run this turn on a catalog model instead of the thread's pinned one (or the provider default).
   * Refused (400) unless the bound `ModelCatalog` lists it as available to this actor and agent.
   */
  model?: string;
  /**
   * When creating a thread (no `threadId`), start it transient — a scratch conversation hidden from
   * the thread list until the caller promotes it. Ignored when `threadId` is set.
   */
  transient?: boolean;
  /** What to do when the thread already has a turn running — see {@link ChatSendMode}. */
  mode?: ChatSendMode;
  /**
   * When creating a thread (no `threadId`), ask the store to create it under this id — the id an
   * AG-UI consumer named the conversation with. A store may ignore it (`CreateThreadInput.id`); the
   * thread's real id is always the one on the result.
   */
  newThreadId?: string;
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

/** Like {@link ThreadDefaultAgentReader}, for the thread's pinned model. */
export interface ThreadModelReader {
  modelForThread(threadId: string): Promise<string | null>;
}

/** The orchestration facade the controllers call. */
@Injectable()
export class AgentService {
  constructor(
    @Inject(AGENT_RUNNER) private readonly runner: AgentRunner,
    @Inject(AGENT_STORE) private readonly store: AgentStore,
    @Inject(AGENT_DEPS_FACTORY) private readonly deps: AgentDepsFactory,
    @Optional()
    @Inject(AGENT_ATTACHMENT_STAGING)
    private readonly staging?: AttachmentStagingStore,
    @Optional()
    @Inject(AGENT_MODEL_CATALOG)
    private readonly models?: ModelCatalog,
    @Optional()
    @Inject(AGENT_QUOTA_PROVIDER)
    private readonly quotaProvider?: QuotaProvider,
    @Optional()
    @Inject(AGENT_OPTIONS)
    private readonly options?: Pick<
      AgentModuleOptions,
      'quota' | 'actionApprovalMode' | 'attachments'
    >,
    @Optional() private readonly queue?: ChatQueueService,
    @Optional() private readonly proposals?: ActionProposalService,
  ) {}

  /**
   * Decide one independent proposal through the scoped proposal service — what the native
   * `action-proposals/:id/approve|reject` routes call — and the reply to show for it. `404` when
   * proposals are not on, `403`/`404` when this actor may not decide it.
   */
  async decideActionProposal(
    actor: Actor,
    threadId: string,
    proposalId: string,
    command: {
      decision: 'approved' | 'rejected';
      remember?: boolean;
      reason?: string;
      via: string;
    },
  ): Promise<{ proposalDecision: ActionProposalMutationView; text: string }> {
    if (this.options?.actionApprovalMode !== 'independent' || !this.proposals) {
      throw new NotFoundException('Proposal not found');
    }
    const result = await this.proposals.decide(threadId, proposalId, actor, command);
    return { proposalDecision: result, text: this.proposals.reply(result, command.decision) };
  }

  async handleTextDecision(threadId: string, actor: Actor, text: string) {
    if (this.options?.actionApprovalMode !== 'independent' || !this.proposals)
      return { status: 'unmatched' as const };
    return this.proposals.handleTextDecision(threadId, actor, text);
  }

  /** How `action` tools wait for their approval here — `AgentModule.forRoot({ actionApprovalMode })`. */
  actionApprovalMode(): ActionApprovalMode {
    return this.options?.actionApprovalMode ?? 'blocking';
  }

  /**
   * The words a text decision is made of (`actionProposalText.vocabulary`, English by default) — what
   * a surface without buttons tells the person to reply.
   */
  actionProposalVocabulary(): TextActionProposalVocabulary {
    return this.proposals?.textVocabulary() ?? DEFAULT_TEXT_ACTION_PROPOSAL_VOCABULARY;
  }

  /** The configured reply (`actionProposalText.replies`) to a decision the store answered with `result`. */
  actionProposalReply(
    result: Pick<ActionProposalMutationView, 'status' | 'proposal'>,
    decision: 'approved' | 'rejected',
  ): string {
    return this.proposals?.reply(result, decision) ?? textActionProposalReply(result, decision);
  }

  /**
   * The proposals of a thread this actor may see — the thread's own actor, or one the policy lets
   * decide them; what `GET <base>/threads/:threadId/action-proposals` serves (its first page).
   * Without independent approvals (the default blocking mode) there are none, so the read answers an
   * empty list rather than refusing; deciding one still refuses.
   */
  async listActionProposals(actor: Actor, threadId: string): Promise<ActionProposalView[]> {
    if (this.options?.actionApprovalMode !== 'independent' || !this.proposals) {
      return [];
    }
    return this.proposals.list(threadId, actor);
  }

  /**
   * The attachment rules in force — what `GET <base>/config` serves and `POST <base>/attachments`
   * enforces. `enabled: false` when no `AGENT_ATTACHMENT_STAGING` provider is bound.
   */
  attachmentLimits(): AttachmentLimits {
    return attachmentLimits(this.options, this.staging);
  }

  /**
   * Stage a file for a later turn, held to the same limits as `POST <base>/attachments` — for a
   * surface that receives files itself (a messaging webhook). Refuses with `501` when attachments are
   * off, `415` for a type outside the allowlist and `413` past the size cap; send the returned
   * `mediaId` as `attachments: [{ mediaId }]`.
   */
  async stageAttachment(
    actor: Actor,
    file: { data: Buffer; contentType: string; filename: string },
  ): Promise<MessageAttachment> {
    if (this.staging === undefined) {
      throw new NotImplementedException(
        'Attachments are not configured on this server: bind AGENT_ATTACHMENT_STAGING ' +
          '(e.g. import AgentMediaAttachmentsModule).',
      );
    }
    const { allowedContentTypes, maxBytes } = this.attachmentLimits();
    const contentType = file.contentType.split(';')[0]?.trim().toLowerCase() ?? '';
    if (!allowedContentTypes.includes(contentType)) {
      throw new UnsupportedMediaTypeException(
        `content type "${contentType}" is not allowed (allowed: ${allowedContentTypes.join(', ')})`,
      );
    }
    if (file.data.byteLength > maxBytes) {
      throw new PayloadTooLargeException(`file exceeds the ${maxBytes}-byte limit`);
    }
    return this.staging.stage({
      data: file.data,
      filename: file.filename,
      contentType,
      sizeBytes: file.data.byteLength,
      actor,
    });
  }
  /** The queue service when the bound store can hold a queue, else `undefined`. */
  private queueing(): ChatQueueService | undefined {
    return this.queue?.supported === true ? this.queue : undefined;
  }

  /** The queue service, or a 501 naming what is missing. */
  private requireQueue(): ChatQueueService {
    const queue = this.queueing();
    if (queue === undefined) {
      throw new NotImplementedException(
        'Queueing messages requires an AgentStore that implements ChatQueueStore; the bound store ' +
          'does not.',
      );
    }
    return queue;
  }

  /**
   * The actor's budget across windows (`GET <base>/quota`) — the bound {@link QuotaProvider}'s
   * report. Without one (a service built outside the module), a day window from the ledger.
   */
  async quotaReport(actor: Actor): Promise<QuotaReport> {
    if (this.quotaProvider !== undefined) {
      return this.quotaProvider.report({ actor });
    }
    const { usedTokens, costUsd } = await this.store.quotaToday(actor.id, utcDay());
    return { windows: [{ period: 'day', usedTokens, usedUsd: costUsd }] };
  }

  /**
   * Refuse a turn the actor's budget no longer covers — only when the host configured one
   * (`quota`): the default report is informational.
   */
  private async assertWithinQuota(actor: Actor): Promise<void> {
    if (this.options?.quota === undefined || this.quotaProvider === undefined) {
      return;
    }
    const report = await this.quotaProvider.report({ actor });
    const { blocked } = report;
    if (blocked !== undefined) {
      publishQuotaBlocked(actor, report, blocked);
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          code: 'quota_exceeded',
          period: blocked.period,
          message:
            blocked.reason ??
            `The ${blocked.period === 'day' ? 'daily' : 'monthly'} quota is used up`,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /**
   * The models `actor` may pick for `agent` (`GET <base>/models`). An empty catalog when none is
   * bound, so a picker simply has nothing to offer.
   */
  async listModels(actor: Actor, agent?: string): Promise<ModelCatalogView> {
    if (this.models === undefined) {
      return { providers: [], default: null };
    }
    return this.models.list({ actor, ...(agent !== undefined ? { agent } : {}) });
  }

  /**
   * `model` if the catalog offers it to this actor and agent right now, else a 400 naming why. The
   * one gate every model choice passes — a send's own, and a thread's pinned one at the moment it is
   * pinned and again at every turn that runs on it (availability can change in between).
   */
  private async assertModelAllowed(actor: Actor, agent: string, model: string): Promise<string> {
    if (this.models === undefined) {
      throw new BadRequestException(
        `model "${model}" cannot be selected: no ModelCatalog is configured (AgentModule.forRoot({ models }))`,
      );
    }
    const entry = findCatalogModel(await this.models.list({ actor, agent }), model);
    if (entry === undefined) {
      throw new BadRequestException(`model "${model}" is not offered`);
    }
    if (!entry.available) {
      throw new BadRequestException(
        `model "${model}" is not available${entry.unavailableReason ? `: ${entry.unavailableReason}` : ''}`,
      );
    }
    return entry.id;
  }

  /**
   * The model a turn runs on: the send's own (that turn only — it is never stored on the thread),
   * else the thread's pinned one, else none. An agent the catalog locks to one model runs on it
   * whatever was sent or pinned, and a send naming another model is refused.
   */
  private async resolveModel(
    actor: Actor,
    agent: string,
    requested: string | undefined,
    threadId: string | undefined,
  ): Promise<string | undefined> {
    const locked =
      this.models !== undefined ? (await this.models.list({ actor, agent })).locked : undefined;
    if (locked !== undefined) {
      if (requested !== undefined && requested !== locked.model) {
        throw new BadRequestException(
          `model "${requested}" cannot be selected: ${locked.reason ?? `this agent always uses "${locked.model}"`}`,
        );
      }
      return locked.model;
    }
    const model = requested ?? (threadId !== undefined ? await this.threadModel(threadId) : null);
    if (model === null || model === undefined) {
      return undefined;
    }
    return this.assertModelAllowed(actor, agent, model);
  }

  private async threadModel(threadId: string): Promise<string | null> {
    const projecting = this.store as Partial<ThreadModelReader>;
    if (typeof projecting.modelForThread === 'function') {
      return projecting.modelForThread(threadId);
    }
    return (await this.store.getThread(threadId))?.model ?? null;
  }

  /**
   * Start a turn — for in-process callers that need a run id back. A send that would have to wait
   * (its thread already has a turn running) is refused with `409` instead; {@link send} is the form
   * that queues it.
   */
  async chat(params: ChatParams): Promise<{ runId: string; threadId: string }> {
    const result = await this.send({ ...params, mode: 'auto' }, { textDecisions: false });
    if ('proposalDecision' in result) throw new Error('Unexpected text decision in run-only API');
    if (result.queued !== true) {
      return result;
    }
    if (result.runId !== undefined) {
      // The thread freed up while it was being queued, and it started straight away.
      return { runId: result.runId, threadId: result.threadId };
    }
    // Take it back out, so this call has no effect — unless it started in the meantime.
    const store = this.requireQueue().queueStore();
    if (!(await store.removeQueuedMessage(result.messageId))) {
      return { runId: result.messageId, threadId: result.threadId };
    }
    await this.requireQueue().publish(result.threadId);
    throw new ConflictException({
      statusCode: 409,
      code: 'run_active',
      message: `thread ${result.threadId} already has a turn running`,
    });
  }

  /**
   * Send a message: start a turn, or — when its thread already has one running — queue the message
   * to run after it (see {@link ChatSendMode}). What `POST <base>/chat` calls.
   */
  async send(
    params: ChatParams,
    sendOptions: { textDecisions?: boolean } = {},
  ): Promise<ChatSendResult> {
    if (
      sendOptions.textDecisions !== false &&
      this.options?.actionApprovalMode === 'independent' &&
      params.threadId !== undefined &&
      params.regenerate !== true &&
      this.proposals
    ) {
      const decision = await this.proposals.handleTextDecision(
        params.threadId,
        params.actor,
        params.message,
      );
      if ('proposalDecision' in decision) return decision;
    }
    // Precedence: explicit agentName > the thread's own defaultAgent (set via updateThread) > the
    // module's configured default. Resolved up front (before thread creation) so a brand-new thread
    // — which has no defaultAgent yet — falls straight through to the module default.
    await this.assertWithinQuota(params.actor);
    // A name a persona took over (`Persona.aliases`) runs as the agent that owns it, under it.
    const target = this.deps.resolveAgent(
      await this.resolveAgentName(params.agentName, params.threadId),
    );
    const agentName = target.agentName;
    const persona = await this.resolvePersona(
      agentName,
      params.personaId ?? target.persona,
      params.threadId,
    );
    const model = await this.resolveModel(params.actor, agentName, params.model, params.threadId);
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
        ...(agentName !== undefined ? { agentName } : {}),
        ...(params.transient === true ? { transient: true } : {}),
        ...(params.newThreadId !== undefined ? { id: params.newThreadId } : {}),
        ...(params.personaId !== undefined ? { persona: params.personaId } : {}),
      });
      threadId = created.id;
    } else {
      // Every send onto an existing thread is gated by ownership: a regenerate rewinds the thread,
      // and a queued message would otherwise land in someone else's conversation.
      if (params.authorized !== true) await this.assertOwnsThread(params.actor, threadId);
      // A persona a send NAMES is the person's pick for this conversation: pinned, so the next send
      // (and a reopened thread's picker) keeps it. One the send fell back to is not pinned.
      if (params.personaId !== undefined) {
        await this.pinThreadPersona(threadId, params.personaId);
      }
    }

    const input: AgentRunInput = {
      threadId,
      actor: params.actor,
      userText: params.message,
      day: utcDay(),
      agentName,
      ...(persona !== undefined ? { persona } : {}),
      ...(params.regenerate === true ? { regenerate: true } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(params.pageContext !== undefined ? { pageContext: params.pageContext } : {}),
      ...(params.uiCapabilities !== undefined ? { uiCapabilities: params.uiCapabilities } : {}),
      ...(params.hostContext !== undefined ? { hostContext: params.hostContext } : {}),
      ...(model !== undefined ? { model } : {}),
    };

    const queue = this.queueing();
    if (queue === undefined) {
      if (this.options?.actionApprovalMode === 'independent')
        throw new Error('Independent actions require queued thread admission');
      // No admission to take: a store that predates the queue starts every send at once.
      const { runId } = await this.runner.start(input);
      await this.store.setActiveStream(threadId, runId);
      return { runId, threadId };
    }

    const mode = params.mode ?? 'auto';
    const { live, stale } = await queue.holder(threadId, this.runner);
    if (stale !== null) {
      // The thread is still pointed at a run that is gone: settle the calls it left showing an
      // approval card before another turn reads the thread.
      await settleDeadRun(this.store, { runId: stale });
    }
    // `queue` always answers as a queued send (202), so a client that asked for it handles one
    // shape; an idle thread starts it straight away all the same (`enqueue` kicks the queue).
    if (live === null && mode !== 'queue') {
      const runId = this.runner.runIdFor?.(input) ?? crypto.randomUUID();
      if (
        await queue
          .queueStore()
          .claimActiveStream(threadId, runId, stale !== null ? { replacing: stale } : {})
      ) {
        return { runId: await this.startClaimed(input, runId), threadId };
      }
      // Lost the race for the thread to another send: fall through and queue behind it.
    }
    if (params.regenerate === true) {
      throw new ConflictException({
        statusCode: 409,
        code: 'run_active',
        message: 'cannot regenerate while a turn is running on this thread',
      });
    }
    return this.enqueue(queue, input, mode, live);
  }

  /**
   * Start a turn the thread is already claimed for, under the claimed id. A runner that minted an
   * id of its own anyway gets the thread re-pointed at it; one that fails to start frees the thread.
   */
  private async startClaimed(input: AgentRunInput, runId: string): Promise<string> {
    const store = this.requireQueue().queueStore();
    let started: string;
    try {
      started = (await this.runner.start(input, { runId })).runId;
    } catch (error) {
      await store.releaseActiveStream(input.threadId, runId);
      throw error;
    }
    if (started !== runId) {
      await store.claimActiveStream(input.threadId, started, { replacing: runId });
    }
    return started;
  }

  /** Put a send in its thread's queue, then drain it if the thread turned out to be free. */
  private async enqueue(
    queue: ChatQueueService,
    input: AgentRunInput,
    mode: ChatSendMode,
    live: string | null,
  ): Promise<QueuedSend> {
    const store = queue.queueStore();
    const threadId = input.threadId;
    const interrupting = mode === 'interrupt' && live !== null ? live : undefined;
    const queued = await store.enqueueMessage({
      threadId,
      actor: input.actor,
      content: input.userText,
      ...(input.attachments !== undefined ? { attachments: input.attachments } : {}),
      ...(input.agentName !== undefined ? { agentName: input.agentName } : {}),
      ...(input.persona !== undefined ? { persona: input.persona } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.pageContext !== undefined ? { pageContext: input.pageContext } : {}),
      ...(input.uiCapabilities !== undefined ? { uiCapabilities: input.uiCapabilities } : {}),
      ...(input.hostContext !== undefined ? { hostContext: input.hostContext } : {}),
      ...(interrupting !== undefined ? { interrupt: true, at: 'head' as const } : {}),
    });
    let runId: string | undefined;
    if (interrupting !== undefined) {
      // An interrupt is a person choosing to run this now: whatever paused the queue, they are
      // overriding it. The cancel settles into the queue, which starts this message.
      await store.setQueuePause(threadId, null);
      await queue.publish(threadId);
      await this.runner.cancel(interrupting);
    } else {
      // The run holding the thread may have settled between our look and our enqueue — its drain
      // then found nothing. Starting the head here covers that; with a live holder it does nothing.
      runId = await queue.kick(threadId, this.runner);
      if (runId === undefined) {
        await queue.publish(threadId);
      }
    }
    const state = await queue.state(threadId);
    const position = state.items.findIndex((item) => item.id === queued.id);
    return {
      threadId,
      queued: true,
      messageId: queued.id,
      position: position === -1 ? 0 : position,
      queue: state,
      ...(runId !== undefined && runId === queued.id ? { runId } : {}),
      ...(interrupting !== undefined ? { interrupting } : {}),
    };
  }

  /** `GET <base>/threads/:id/queue` — the thread's waiting messages and whether it drains. */
  async getQueue(actor: Actor, threadId: string): Promise<ChatQueueState> {
    await this.assertOwnsThread(actor, threadId);
    return this.requireQueue().state(threadId);
  }

  /**
   * `PATCH <base>/queue/:messageId` — change a waiting message's text and/or attachments, and/or move
   * it to `position` in the queue. Answers the thread's queue.
   */
  async updateQueuedMessage(
    actor: Actor,
    messageId: string,
    patch: { message?: string; attachments?: AttachmentRef[] | null; position?: number },
  ): Promise<ChatQueueState> {
    const queue = this.requireQueue();
    const store = queue.queueStore();
    const threadId = await this.assertOwnsQueuedMessage(actor, messageId);
    if (patch.message !== undefined && patch.message.trim().length === 0) {
      throw new BadRequestException('message must not be empty');
    }
    const attachments =
      patch.attachments === undefined || patch.attachments === null
        ? patch.attachments
        : await this.resolveAttachments(actor, patch.attachments);
    if (patch.message !== undefined || attachments !== undefined) {
      const updated = await store.updateQueuedMessage(messageId, {
        ...(patch.message !== undefined ? { content: patch.message } : {}),
        ...(attachments !== undefined ? { attachments } : {}),
      });
      if (updated === null) {
        throw new GoneException(`queued message ${messageId} already started or was removed`);
      }
    }
    if (patch.position !== undefined) {
      if (!Number.isInteger(patch.position) || patch.position < 0) {
        throw new BadRequestException('position must be a non-negative integer');
      }
      if (!(await store.moveQueuedMessage(messageId, patch.position))) {
        throw new GoneException(`queued message ${messageId} already started or was removed`);
      }
    }
    return queue.publish(threadId);
  }

  /** `DELETE <base>/queue/:messageId` — drop a waiting message. Answers the thread's queue. */
  async removeQueuedMessage(actor: Actor, messageId: string): Promise<ChatQueueState> {
    const queue = this.requireQueue();
    const threadId = await this.assertOwnsQueuedMessage(actor, messageId);
    if (!(await queue.queueStore().removeQueuedMessage(messageId))) {
      throw new GoneException(`queued message ${messageId} already started or was removed`);
    }
    return queue.publish(threadId);
  }

  /**
   * `POST <base>/queue/:messageId/interrupt` — run a message that is already waiting NOW: it moves
   * to the head of its queue marked as an interrupt, any pause is lifted, and the running turn is
   * cancelled (its settle starts this message — the same path a `mode: 'interrupt'` send takes).
   * With nothing running, the message starts at once.
   *
   * One request, and the message never leaves the queue: a client that removed it and sent it again
   * would lose it if the second call failed, and would run it twice if another tab's drain started
   * it in between. Answers the queue, plus `interrupting` (the run that was cancelled) or `runId`
   * (the run this message started).
   */
  async interruptQueuedMessage(
    actor: Actor,
    messageId: string,
  ): Promise<ChatQueueState & { runId?: string; interrupting?: string }> {
    const queue = this.requireQueue();
    const store = queue.queueStore();
    const threadId = await this.assertOwnsQueuedMessage(actor, messageId);
    const gone = () =>
      new GoneException(`queued message ${messageId} already started or was removed`);
    const marked = await store.updateQueuedMessage(messageId, { interrupt: true });
    if (marked === null) {
      throw gone();
    }
    if (marked.interrupt !== true) {
      // Cancelling for a message the store did not mark would pause the queue behind the cancel
      // instead of starting it — refuse before anything is cancelled.
      throw new NotImplementedException(
        'Interrupting a queued message requires a ChatQueueStore whose updateQueuedMessage stores ' +
          '`interrupt`; the bound store ignored it.',
      );
    }
    if (!(await store.moveQueuedMessage(messageId, 0))) {
      throw gone();
    }
    // A person choosing to run this now overrides whatever paused the queue.
    await store.setQueuePause(threadId, null);
    const { live } = await queue.holder(threadId, this.runner);
    if (live !== null && live !== messageId && (await store.getQueuedMessage(messageId)) !== null) {
      const state = await queue.publish(threadId);
      await this.runner.cancel(live);
      return { ...state, interrupting: live };
    }
    if (live !== null) {
      // The drain started it while this request was on its way: it is the running turn already.
      return { ...(await queue.state(threadId)), runId: messageId };
    }
    const runId = await queue.kick(threadId, this.runner);
    const state = runId === undefined ? await queue.publish(threadId) : await queue.state(threadId);
    return { ...state, ...(runId !== undefined ? { runId } : {}) };
  }

  /** `DELETE <base>/threads/:id/queue` — drop every waiting message (and any pause). */
  async clearQueue(actor: Actor, threadId: string): Promise<ChatQueueState> {
    await this.assertOwnsThread(actor, threadId);
    const queue = this.requireQueue();
    await queue.queueStore().clearQueue(threadId);
    await queue.queueStore().setQueuePause(threadId, null);
    return queue.publish(threadId);
  }

  /**
   * `POST <base>/threads/:id/queue/resume` — lift a pause and start the head when nothing is
   * running. Answers the queue, and the run the head started under, if it did.
   */
  async resumeQueue(actor: Actor, threadId: string): Promise<ChatQueueState & { runId?: string }> {
    await this.assertOwnsThread(actor, threadId);
    const queue = this.requireQueue();
    await queue.queueStore().setQueuePause(threadId, null);
    const runId = await queue.kick(threadId, this.runner);
    const state = runId === undefined ? await queue.publish(threadId) : await queue.state(threadId);
    return { ...state, ...(runId !== undefined ? { runId } : {}) };
  }

  /** The thread a queued message waits on, once the caller is shown to own it. */
  private async assertOwnsQueuedMessage(actor: Actor, messageId: string): Promise<string> {
    const message = await this.requireQueue().queueStore().getQueuedMessage(messageId);
    if (message === null) {
      throw new NotFoundException(`queued message ${messageId} not found`);
    }
    await this.assertOwnsThread(actor, message.threadId);
    return message.threadId;
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

  /**
   * Approve a parked action call as `actor`. Who may is the call's recorded approver's business
   * (see {@link assertMayDecide}); `remember` approves later calls of the same tool in the same
   * thread, and `via` names the surface the decision came through (`'web'`, `'slack'`, …) — both
   * persisted with the call.
   */
  async approve(
    actor: Actor,
    toolCallId: string,
    opts: { remember?: boolean; via?: string } = {},
  ): Promise<void> {
    await this.assertMayDecide(actor, toolCallId);
    return this.signalToolCall(toolCallId, {
      approved: true,
      executedByRef: actor.id,
      ...(opts.remember === true ? { remember: true } : {}),
      ...(opts.via !== undefined ? { decidedVia: opts.via } : {}),
    });
  }

  async reject(
    actor: Actor,
    toolCallId: string,
    reason?: string,
    opts: { via?: string } = {},
  ): Promise<void> {
    await this.assertMayDecide(actor, toolCallId);
    return this.signalToolCall(toolCallId, {
      approved: false,
      executedByRef: actor.id,
      ...(reason !== undefined ? { reason } : {}),
      ...(opts.via !== undefined ? { decidedVia: opts.via } : {}),
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
    opts: { via?: string } = {},
  ): Promise<void> {
    await this.assertOwnsToolCall(actor, toolCallId);
    await this.assertAnswersFit(toolCallId, answers);
    const reply: ElicitationReply = {
      answers,
      answeredByRef: actor.id,
      ...(opts.via !== undefined ? { answeredVia: opts.via } : {}),
    };
    return this.signalToolCall(toolCallId, reply);
  }

  /**
   * Decline to answer and let the agent proceed on its own assumptions. NOT the same as confirming
   * them: the run records this as a rejection, so a reader auditing what the agent was told can
   * tell a choice the user made from one they refused to make.
   */
  async skip(actor: Actor, toolCallId: string, opts: { via?: string } = {}): Promise<void> {
    await this.assertOwnsToolCall(actor, toolCallId);
    const reply: ElicitationReply = {
      answers: {},
      skipped: true,
      answeredByRef: actor.id,
      ...(opts.via !== undefined ? { answeredVia: opts.via } : {}),
    };
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
    if ((await this.store.toolCallApproval?.(toolCallId))?.status === 'proposed')
      throw new ConflictException(
        'Independent proposals require the scoped proposal decision route',
      );
    await this.assertNotExpired(toolCallId);
    const runId = await this.resolveRunForToolCall(toolCallId);
    await this.assertRunWaiting(runId);
    return this.runner.signal(runId, toolCallId, reply);
  }

  /**
   * Refuse a decision addressed at a run that is over (`409 run_not_active`). The runtime would take
   * the signal and buffer it for a run that never comes back — the person's "yes" is accepted, the
   * card says so, and nothing runs. Settles the calls the dead run left awaiting a decision on the
   * way out, so the card stops asking. A runner that cannot say whether a run is alive is taken at
   * its word that it is, and so is one that fails to answer.
   */
  private async assertRunWaiting(runId: string): Promise<void> {
    if (typeof this.runner.isRunActive !== 'function') {
      return;
    }
    const active = await this.runner.isRunActive(runId).catch(() => true);
    if (active) {
      return;
    }
    await settleDeadRun(this.store, { runId });
    throw new RunNotActiveException(runId);
  }

  /** Who owns the thread, or `null` when there is no such (live) thread. */
  async threadOwner(threadId: string): Promise<string | null> {
    return this.store.ownerOfThread(threadId);
  }

  /**
   * May `actor` continue the run whose stream is `runId` — the AG-UI resume? Only the actor whose
   * thread is streaming it (`403` otherwise), and only while it still is: a run that is over is
   * waiting on no one (`409 run_not_active`), whatever an old interrupt id says.
   */
  async assertResumable(actor: Actor, runId: string): Promise<void> {
    const owner = await this.store.ownerOfActiveStream(runId);
    if (owner === null) {
      throw new RunNotActiveException(runId);
    }
    if (owner !== actor.id) {
      throw new ForbiddenException('run belongs to another actor');
    }
  }

  /**
   * Everything {@link approve} / {@link reject} check before they signal — who may decide, and
   * that the request has not lapsed — without signalling. For a caller that settles several
   * decisions at once and must refuse all of them if one is refused (an AG-UI resume).
   */
  async checkDecision(actor: Actor, toolCallId: string): Promise<void> {
    await this.assertMayDecide(actor, toolCallId);
    await this.assertNotExpired(toolCallId);
  }

  /** Everything {@link answer} checks before it signals, without signalling — see {@link checkDecision}. */
  async checkAnswer(
    actor: Actor,
    toolCallId: string,
    answers: Record<string, string[]>,
  ): Promise<void> {
    await this.assertOwnsToolCall(actor, toolCallId);
    await this.assertAnswersFit(toolCallId, answers);
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
    return thread === null ? null : this.toDetailView(thread, actor);
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
    if (
      patch.defaultAgent === undefined &&
      patch.model === undefined &&
      patch.persona === undefined
    ) {
      if (title !== undefined) {
        await this.store.setTitle(threadId, title);
      }
      return;
    }
    if (this.store.updateThread === undefined) {
      throw new NotImplementedException(
        "Setting a thread's defaultAgent, model or persona requires an AgentStore that implements " +
          'updateThread(); the bound store does not support it.',
      );
    }
    // Pinned against the agent the thread's next turn will run as — the one the patch sets, else
    // the thread's own default, else the module's.
    const model =
      patch.model === undefined || patch.model === null
        ? patch.model
        : await this.assertModelAllowed(
            actor,
            patch.defaultAgent ?? (await this.resolveAgentName(undefined, threadId)),
            patch.model,
          );
    // Validated against the agent the thread's next turn will run as, like the model above.
    if (patch.persona !== undefined && patch.persona !== null) {
      this.deps.resolvePersona({
        agentName: this.deps.resolveAgent(
          patch.defaultAgent ?? (await this.resolveAgentName(undefined, threadId)),
        ).agentName,
        requested: patch.persona,
      });
    }
    await this.store.updateThread(threadId, {
      ...(title !== undefined ? { title } : {}),
      ...(patch.defaultAgent !== undefined ? { defaultAgent: patch.defaultAgent } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(patch.persona !== undefined ? { persona: patch.persona } : {}),
    });
  }

  /**
   * The persona this send runs under — see {@link AgentDepsFactory.resolvePersona}. The thread's
   * pinned persona is read only when the send names none AND the agent has personas to pick from.
   */
  private async resolvePersona(
    agentName: string,
    requested: string | undefined,
    threadId: string | undefined,
  ): Promise<string | undefined> {
    const needsThread =
      requested === undefined &&
      threadId !== undefined &&
      this.deps.personaCatalog(agentName).length > 0;
    return this.deps.resolvePersona({
      agentName,
      ...(requested !== undefined ? { requested } : {}),
      ...(needsThread ? { threadPersona: await threadPersona(this.store, threadId) } : {}),
    });
  }

  /** Pin `persona` on the thread when it is not already — a no-op on a store that cannot. */
  private async pinThreadPersona(threadId: string, persona: string): Promise<void> {
    if (this.store.updateThread === undefined) {
      return;
    }
    if ((await threadPersona(this.store, threadId)) !== persona) {
      await this.store.updateThread(threadId, { persona });
    }
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
      model: thread.model ?? null,
      persona: thread.persona ?? null,
      activeRunId: (await this.store.activeRunForThread?.(thread.id)) ?? thread.activeRunId ?? null,
    };
  }

  private async toDetailView(thread: ThreadDetail, actor: Actor): Promise<ThreadDetail> {
    const summary = await this.toSummaryView(thread);
    const queue = this.queueing();
    return {
      ...summary,
      messages: await this.freshAttachmentUrls(thread.messages, actor),
      ...(queue !== undefined ? { queue: await queue.state(thread.id) } : {}),
    };
  }

  /**
   * Re-mint each replayed attachment's url from the staging store, by `mediaId`: the url persisted
   * with the message was minted for THAT turn (a presigned url with an expiry), so an old turn would
   * otherwise show a dead link. The store's own access check applies — an attachment it will not
   * resolve for this actor keeps the url it was stored with.
   */
  private async freshAttachmentUrls(
    messages: StoredMessage[],
    actor: Actor,
  ): Promise<StoredMessage[]> {
    const staging = this.staging;
    if (staging === undefined || !messages.some((message) => message.attachments?.length)) {
      return messages;
    }
    return Promise.all(
      messages.map(async (message) => {
        if (message.attachments === undefined || message.attachments.length === 0) return message;
        const attachments = await Promise.all(
          message.attachments.map(async (attachment) => {
            try {
              const fresh = await staging.resolve({ mediaId: attachment.mediaId, actor });
              return fresh ?? attachment;
            } catch {
              return attachment;
            }
          }),
        );
        return { ...message, attachments };
      }),
    );
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
   * Rate a message in one of `actor`'s threads: `'up'`/`'down'` with an optional comment, or `null`
   * to clear the rating. Answers `404` for an unknown message, `403` for another actor's, and `501`
   * on a store without `threadOfMessage` + `setMessageFeedback`.
   */
  async setMessageFeedback(
    actor: Actor,
    messageId: string,
    input: { value: MessageFeedbackValue | null; comment?: string },
  ): Promise<MessageFeedback | null> {
    if (input.value !== null && input.value !== 'up' && input.value !== 'down') {
      throw new BadRequestException("value must be 'up', 'down' or null");
    }
    if (input.comment !== undefined && typeof input.comment !== 'string') {
      throw new BadRequestException('comment must be a string');
    }
    const comment = input.comment?.trim();
    if (comment !== undefined && comment.length > 2000) {
      throw new BadRequestException('comment must be at most 2000 characters');
    }
    if (this.store.threadOfMessage === undefined || this.store.setMessageFeedback === undefined) {
      throw new NotImplementedException(
        'Message feedback requires an AgentStore that implements threadOfMessage() and ' +
          'setMessageFeedback(); the bound store does not support it.',
      );
    }
    const threadId = await this.store.threadOfMessage(messageId);
    if (threadId === null) {
      throw new NotFoundException(`message ${messageId} not found`);
    }
    await this.assertOwnsThread(actor, threadId);
    const feedback: MessageFeedback | null =
      input.value === null
        ? null
        : {
            value: input.value,
            ...(comment !== undefined && comment.length > 0 ? { comment } : {}),
            updatedAt: new Date().toISOString(),
          };
    await this.store.setMessageFeedback(messageId, feedback);
    return feedback;
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
   * Check a reply against the questions it answers before it is signalled: every submitted value a
   * question's own rules accept (a typed input's type, bounds and pattern; a pick from the offered
   * options), and every `required` question answered — by the reply, or by the defaults an omitted
   * question falls back to. A reply the loop would have to drop parts of is refused here instead, so
   * the person who typed it hears why. Needs the store to hand back the call's recorded questions;
   * without that seam the loop's own filtering is the only check.
   */
  private async assertAnswersFit(
    toolCallId: string,
    answers: Record<string, string[]>,
  ): Promise<void> {
    if (this.store.toolCallInput === undefined) {
      return;
    }
    const questions = readElicitationQuestions(await this.store.toolCallInput(toolCallId));
    for (const question of questions) {
      const submitted = Object.hasOwn(answers, question.id) ? answers[question.id] : undefined;
      const problem = validateElicitationAnswer(question, submitted ?? question.defaults ?? []);
      if (problem !== null) {
        throw new BadRequestException(`answers["${question.id}"] ${problem}`);
      }
    }
  }

  /**
   * Authorization seam for approve/reject. The call's recorded approver decides who may settle it:
   * the requester (the default, and every call recorded before approvers existed) is the thread's
   * own actor — the ownership check this always was; any other approver goes through the policy's
   * `canDecide`, which by default asks whether the actor holds that role.
   */
  private async assertMayDecide(actor: Actor, toolCallId: string): Promise<void> {
    const approval = await this.store.toolCallApproval?.(toolCallId);
    const approver = approval?.approver ?? REQUESTER_APPROVER;
    if (approver === REQUESTER_APPROVER) {
      return this.assertOwnsToolCall(actor, toolCallId);
    }
    const requesterRef = await this.store.ownerOfToolCall(toolCallId);
    if (requesterRef === null) {
      throw new NotFoundException(`tool call ${toolCallId} not found`);
    }
    const allowed = await mayDecideApproval(this.deps.forAgent().approvalPolicy, actor, {
      toolCallId,
      approver,
      requesterRef,
    });
    if (!allowed) {
      throw new ForbiddenException(`this approval is for ${approver}`);
    }
  }

  /**
   * Refuse a decision on a request that has already lapsed — recorded `expired`, or past its
   * `expiresAt` with the run's own timer about to fire. Signalling it anyway would race the timeout:
   * a durable runtime buffers a signal nobody is waiting on, and a late approval must not be what a
   * later replay of the run reads back.
   */
  private async assertNotExpired(toolCallId: string): Promise<void> {
    const approval = await this.store.toolCallApproval?.(toolCallId);
    if (approval === null || approval === undefined) {
      return;
    }
    const lapsed =
      approval.status === 'expired' ||
      (approval.status === 'pending_approval' &&
        approval.expiresAt !== null &&
        Date.parse(approval.expiresAt) <= Date.now());
    if (lapsed) {
      throw new GoneException(`the approval request for tool call ${toolCallId} has expired`);
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
