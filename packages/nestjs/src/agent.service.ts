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
} from '@dudousxd/nestjs-agent-core';
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
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
    const agentName = params.agentName ?? this.deps.defaultAgentName();
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

  listThreads(actorRef: string): Promise<ThreadSummary[]> {
    return this.store.listThreads(actorRef);
  }

  async getThread(actor: Actor, threadId: string): Promise<ThreadDetail | null> {
    await this.assertOwnsThread(actor, threadId);
    return this.store.getThread(threadId);
  }

  async deleteThread(actor: Actor, threadId: string): Promise<void> {
    await this.assertOwnsThread(actor, threadId);
    return this.store.softDeleteThread(threadId);
  }

  async forkThread(actor: Actor, threadId: string, fromMessageId: string): Promise<ThreadSummary> {
    await this.assertOwnsThread(actor, threadId);
    return this.store.forkThread(threadId, fromMessageId);
  }

  async renameThread(actor: Actor, threadId: string, title: string): Promise<void> {
    const trimmed = title.trim();
    if (trimmed.length === 0) {
      throw new BadRequestException('title must not be empty');
    }
    if (trimmed.length > 200) {
      throw new BadRequestException('title must be at most 200 characters');
    }
    await this.assertOwnsThread(actor, threadId);
    return this.store.setTitle(threadId, trimmed);
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
