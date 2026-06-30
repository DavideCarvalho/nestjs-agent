import {
  AGENT_RUNNER,
  AGENT_SINK,
  AGENT_STORE,
  type Actor,
  type AgentRunInput,
  type AgentRunner,
  type AgentStore,
  type PageContext,
  type Persona,
  type ThreadDetail,
  type ThreadSummary,
  type TokenStreamSink,
} from '@dudousxd/nestjs-agent-core';
import { Inject, Injectable } from '@nestjs/common';
import { AGENT_DEPS, type AgentDeps, utcDay } from './agent-deps.js';

export interface ChatParams {
  actor: Actor;
  message: string;
  threadId?: string;
  personaId?: string;
  pageContext?: PageContext;
}

/** The orchestration facade the controllers call. */
@Injectable()
export class AgentService {
  constructor(
    @Inject(AGENT_RUNNER) private readonly runner: AgentRunner,
    @Inject(AGENT_STORE) private readonly store: AgentStore,
    @Inject(AGENT_SINK) private readonly sink: TokenStreamSink,
    @Inject(AGENT_DEPS) private readonly deps: AgentDeps,
  ) {}

  async chat(params: ChatParams): Promise<{ runId: string; threadId: string }> {
    let threadId = params.threadId;
    if (threadId === undefined) {
      const created = await this.store.createThread({
        actor: params.actor,
        persona: params.personaId ?? this.deps.defaultPersona,
      });
      threadId = created.id;
    }

    const persona = this.resolvePersona(params.personaId);
    const input: AgentRunInput = {
      threadId,
      actor: params.actor,
      userText: params.message,
      day: utcDay(),
      ...(persona !== undefined ? { persona } : {}),
      ...(params.pageContext !== undefined ? { pageContext: params.pageContext } : {}),
    };

    const { runId } = await this.runner.start(input);
    await this.store.setActiveStream(threadId, runId);
    return { runId, threadId };
  }

  subscribe(runId: string): AsyncIterable<Uint8Array> {
    return this.sink.subscribe(runId);
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

  resolvePersona(id?: string): Persona | undefined {
    return this.deps.personas.get(id ?? this.deps.defaultPersona);
  }

  personaCatalog(): { id: string; label: string }[] {
    return [...this.deps.personas.values()].map((persona) => ({
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
