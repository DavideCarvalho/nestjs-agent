import {
  AGENT_DEPS_FACTORY,
  AGENT_RUNNER,
  AGENT_STORE,
  type Actor,
  type AgentRunInput,
  type AgentRunner,
  type AgentStore,
  type PageContext,
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
  pageContext?: PageContext;
  /** Re-run the last exchange instead of adding a new message. Requires an existing `threadId`. */
  regenerate?: boolean;
}

/** The orchestration facade the controllers call. */
@Injectable()
export class AgentService {
  constructor(
    @Inject(AGENT_RUNNER) private readonly runner: AgentRunner,
    @Inject(AGENT_STORE) private readonly store: AgentStore,
    @Inject(AGENT_DEPS_FACTORY) private readonly deps: AgentDepsFactory,
  ) {}

  async chat(params: ChatParams): Promise<{ runId: string; threadId: string }> {
    const agentName = params.agentName ?? this.deps.defaultAgentName();
    let threadId = params.threadId;
    if (threadId === undefined) {
      if (params.regenerate === true) {
        throw new BadRequestException('regenerate requires an existing threadId');
      }
      const created = await this.store.createThread({ actor: params.actor });
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

  async quotaToday(actorRef: string): Promise<{ usedTokens: number }> {
    return this.store.quotaToday(actorRef, utcDay());
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
