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
import { Inject, Injectable } from '@nestjs/common';
import type { AgentDepsFactory } from './agent-deps.factory.js';
import { utcDay } from './agent-deps.js';

export interface ChatParams {
  actor: Actor;
  message: string;
  threadId?: string;
  agentName?: string;
  personaId?: string;
  pageContext?: PageContext;
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
      const created = await this.store.createThread({
        actor: params.actor,
        persona: params.personaId ?? this.deps.forAgent(agentName).defaultPersona,
      });
      threadId = created.id;
    }

    const persona = this.resolvePersona(agentName, params.personaId);
    const input: AgentRunInput = {
      threadId,
      actor: params.actor,
      userText: params.message,
      day: utcDay(),
      agentName,
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

  approve(runId: string, toolCallId: string): Promise<void> {
    return this.runner.signal(runId, toolCallId, { approved: true });
  }

  reject(runId: string, toolCallId: string, reason?: string): Promise<void> {
    return this.runner.signal(runId, toolCallId, {
      approved: false,
      ...(reason !== undefined ? { reason } : {}),
    });
  }

  cancel(runId: string): Promise<void> {
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

  getThread(threadId: string): Promise<ThreadDetail | null> {
    return this.store.getThread(threadId);
  }

  deleteThread(threadId: string): Promise<void> {
    return this.store.softDeleteThread(threadId);
  }

  forkThread(threadId: string, fromMessageId: string): Promise<ThreadSummary> {
    return this.store.forkThread(threadId, fromMessageId);
  }

  async quotaToday(actorRef: string): Promise<{ usedTokens: number }> {
    return this.store.quotaToday(actorRef, utcDay());
  }
}
