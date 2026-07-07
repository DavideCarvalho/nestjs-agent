import {
  AGENT_DEPS_FACTORY,
  AGENT_RUNNER,
  AGENT_STORE,
  type Actor,
  type AgentRunInput,
  type AgentRunner,
  type AgentStore,
  type PageContext,
  type Persona,
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
  personaId?: string;
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
      const created = await this.store.createThread({
        actor: params.actor,
        persona: params.personaId ?? this.deps.forAgent(agentName).defaultPersona,
      });
      threadId = created.id;
    } else if (params.regenerate === true) {
      // Regenerate re-runs a run on an existing thread — gate it by ownership like the other
      // thread-scoped actions so one actor can't rewind another's conversation.
      await this.assertOwnsThread(params.actor, threadId);
    }

    const persona = this.resolvePersona(agentName, params.personaId);
    const input: AgentRunInput = {
      threadId,
      actor: params.actor,
      userText: params.message,
      day: utcDay(),
      agentName,
      ...(params.regenerate === true ? { regenerate: true } : {}),
      ...(persona !== undefined ? { persona } : {}),
      ...(params.pageContext !== undefined ? { pageContext: params.pageContext } : {}),
    };

    const { runId } = await this.runner.start(input);
    await this.store.setActiveStream(threadId, runId);
    return { runId, threadId };
  }

  subscribe(runId: string): AsyncIterable<Uint8Array> {
    return this.deps.forAgent().sink.subscribe(runId);
  }

  async approve(actor: Actor, runId: string, toolCallId: string): Promise<void> {
    await this.assertOwnsToolCall(actor, toolCallId);
    return this.runner.signal(runId, toolCallId, { approved: true });
  }

  async reject(actor: Actor, runId: string, toolCallId: string, reason?: string): Promise<void> {
    await this.assertOwnsToolCall(actor, toolCallId);
    return this.runner.signal(runId, toolCallId, {
      approved: false,
      ...(reason !== undefined ? { reason } : {}),
    });
  }

  async cancel(actor: Actor, runId: string): Promise<void> {
    await this.assertOwnsActiveStream(actor, runId);
    return this.runner.cancel(runId);
  }

  resolvePersona(agentName?: string, id?: string): Persona | undefined {
    const deps = this.deps.forAgent(agentName);
    return deps.personas.get(id ?? deps.defaultPersona);
  }

  personaCatalog(agentName?: string): { id: string; label: string }[] {
    return [...this.deps.forAgent(agentName).personas.values()].map((persona) => ({
      id: persona.id,
      label: persona.label,
    }));
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

  /** Authorization seam for HITL approve/reject: the caller must own the tool call's thread. */
  private async assertOwnsToolCall(actor: Actor, toolCallId: string): Promise<void> {
    const owner = await this.store.ownerOfToolCall(toolCallId);
    if (owner === null) {
      throw new NotFoundException(`tool call ${toolCallId} not found`);
    }
    if (owner !== actor.id) {
      throw new ForbiddenException('tool call belongs to another actor');
    }
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
