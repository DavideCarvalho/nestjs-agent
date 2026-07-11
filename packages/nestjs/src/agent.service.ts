import {
  AGENT_DEPS_FACTORY,
  AGENT_QUOTA_STORE,
  AGENT_RUNNER,
  AGENT_STORE,
  type Actor,
  type AgentRunInput,
  type AgentRunner,
  type AgentStore,
  type MessageAttachment,
  type PageContext,
  type QuotaStore,
  type QuotaView,
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
} from '@nestjs/common';
import type { AgentDepsFactory } from './agent-deps.factory.js';
import { utcDay } from './agent-deps.js';

export interface ChatParams {
  actor: Actor;
  message: string;
  threadId?: string;
  agentName?: string;
  /** Files attached to this message (image/PDF) for a vision-capable model. */
  attachments?: MessageAttachment[];
  pageContext?: PageContext;
  /** Re-run the last exchange instead of adding a new message. Requires an existing `threadId`. */
  regenerate?: boolean;
  /**
   * When creating a thread (no `threadId`), start it transient — a scratch conversation hidden from
   * the thread list until the caller promotes it. Ignored when `threadId` is set.
   */
  transient?: boolean;
}

/** The orchestration facade the controllers call. */
@Injectable()
export class AgentService {
  constructor(
    @Inject(AGENT_RUNNER) private readonly runner: AgentRunner,
    @Inject(AGENT_STORE) private readonly store: AgentStore,
    @Inject(AGENT_DEPS_FACTORY) private readonly deps: AgentDepsFactory,
    @Inject(AGENT_QUOTA_STORE) private readonly quota: QuotaStore | undefined,
  ) {}

  async chat(params: ChatParams): Promise<{ runId: string; threadId: string }> {
    // Precedence: explicit agentName > the thread's own defaultAgent (set via updateThread) > the
    // module's configured default. Resolved up front (before thread creation) so a brand-new thread
    // — which has no defaultAgent yet — falls straight through to the module default.
    const agentName = await this.resolveAgentName(params.agentName, params.threadId);
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
      ...(params.attachments !== undefined ? { attachments: params.attachments } : {}),
      ...(params.pageContext !== undefined ? { pageContext: params.pageContext } : {}),
    };

    const { runId } = await this.runner.start(input);
    await this.store.setActiveStream(threadId, runId);
    return { runId, threadId };
  }

  subscribe(runId: string): AsyncIterable<Uint8Array> {
    return this.deps.forAgent().sink.subscribe(runId);
  }

  async approve(actor: Actor, toolCallId: string): Promise<void> {
    const runId = await this.runForOwnedToolCall(actor, toolCallId);
    return this.runner.signal(runId, toolCallId, { approved: true });
  }

  async reject(actor: Actor, toolCallId: string, reason?: string): Promise<void> {
    const runId = await this.runForOwnedToolCall(actor, toolCallId);
    return this.runner.signal(runId, toolCallId, {
      approved: false,
      ...(reason !== undefined ? { reason } : {}),
    });
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
   * Skips the thread lookup entirely when the caller already named an agent or there's no thread yet.
   */
  private async resolveAgentName(
    agentName: string | undefined,
    threadId: string | undefined,
  ): Promise<string> {
    if (agentName !== undefined) {
      return agentName;
    }
    if (threadId !== undefined) {
      const thread = await this.store.getThread(threadId);
      if (thread?.defaultAgent !== undefined && thread.defaultAgent !== null) {
        return thread.defaultAgent;
      }
    }
    return this.deps.defaultAgentName();
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
   * Authorization + routing seam for HITL approve/reject: assert the caller owns the tool call's
   * thread, then resolve the run currently awaiting that call (its thread's active stream). That run
   * is the sub-agent's own child run when the pending call belongs to a delegated agent — the client
   * never knows or supplies a runId; it is derived here from the tool call alone.
   */
  private async runForOwnedToolCall(actor: Actor, toolCallId: string): Promise<string> {
    const owner = await this.store.ownerOfToolCall(toolCallId);
    if (owner === null) {
      throw new NotFoundException(`tool call ${toolCallId} not found`);
    }
    if (owner !== actor.id) {
      throw new ForbiddenException('tool call belongs to another actor');
    }
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
