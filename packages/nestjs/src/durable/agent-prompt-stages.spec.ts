// Enabling memory, retrieval or skills is module config, and each of the three spends a checkpoint
// position. These tests hold the line that a run already in flight keeps the sequence it recorded
// when an operator switches one of them on: a turn parks on a human's approval with all three off,
// a second process brings them up, and the approval still lands.
import type {
  AgentLoopResult,
  AgentRunInput,
  MemoryProvider,
  MemoryRecord,
  ModelProvider,
  ModelTurnArgs,
  ModelTurnResult,
  Passage,
  Retriever,
} from '@dudousxd/nestjs-agent-core';
import { InMemoryAgentStore } from '@dudousxd/nestjs-agent-testing';
import { DurableModule } from '@dudousxd/nestjs-durable';
import {
  InMemoryStateStore,
  type WorkflowCtx,
  WorkflowEngine,
} from '@dudousxd/nestjs-durable-core';
import { EventEmitterTransport } from '@dudousxd/nestjs-durable-transport-event-emitter';
import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AgentModule } from '../agent.module.js';
import { AgentService } from '../agent.service.js';
import { Agent } from '../decorator/agent.decorator.js';
import { AiTool } from '../decorator/ai-tool.decorator.js';
import { Skill } from '../decorator/skill.decorator.js';
import { HeaderActorResolver } from '../resolver/header-actor-resolver.js';
import { AgentDurableModule } from './agent-durable.module.js';
import { AgentRunWorkflow } from './agent-run.workflow.js';

const ACTOR = { id: 'u1', roles: ['ADMIN'] };

/** An action tool, so a turn can be parked on its approval signal and resumed by a second process. */
@AiTool({ name: 'publish', kind: 'action', description: 'publish', input: z.object({}) })
@Injectable()
class PublishTool {
  async execute(): Promise<{ published: boolean }> {
    return { published: true };
  }
}

@Agent({ name: 'default', systemPrompt: 'prompt stages test agent', model: 'fake-1' })
@Injectable()
class DefaultAgent {}

@Skill({
  name: 'weekly-report',
  description: 'how the weekly report is put together',
  body: 'Pull the figures, then summarise them in one paragraph.',
})
@Injectable()
class WeeklyReportSkill {}

/** One action call on the first turn, then a plain answer — so the turn parks, then finishes. */
class ActionToolModel implements ModelProvider {
  readonly prompts: string[] = [];

  async runTurn(args: ModelTurnArgs): Promise<ModelTurnResult> {
    this.prompts.push(args.system);
    const turnIndex = args.messages.filter((message) => message.role === 'assistant').length;
    const text = turnIndex === 0 ? 'about to publish' : 'published';
    await args.sink.write(new TextEncoder().encode(text));
    return {
      text,
      toolCalls: turnIndex === 0 ? [{ id: 'call-publish', name: 'publish', input: {} }] : [],
      usage: { inputTokens: args.messages.length, outputTokens: text.length },
    };
  }
}

function memoryProvider(): MemoryProvider {
  const rows: MemoryRecord[] = [
    {
      id: 'actor:u1/units',
      key: 'units',
      text: 'they read distances in kilometres',
      scope: 'actor:u1',
      origin: { author: 'agent', threadId: 't0', runId: 'r0', actorRef: 'u1' },
      updatedAt: '2026-09-01T00:00:00.000Z',
    },
  ];
  return {
    list: ({ scopes }) => rows.filter((row) => scopes.includes(row.scope)),
    forget: () => false,
  };
}

function retriever(): Retriever {
  return {
    retrieve: (): Promise<Passage[]> =>
      Promise.resolve([
        { id: 'p1', text: 'The quarter closes on the last Friday.', score: 1, source: 'handbook' },
      ]),
  };
}

/** What the three prompt stages are worth to a turn, as a host switches them on. */
interface Stages {
  memory?: boolean;
  retrieval?: boolean;
  skills?: boolean;
}

interface Shared {
  stateStore: InMemoryStateStore;
  agentStore: InMemoryAgentStore;
  model: ActionToolModel;
}

/**
 * The `agent.run` body as a release that had no journaled stage set wrote it: `ctx.patched` answers
 * `false` for the marker without consuming a position, which is what the real `ctx.patched` answers
 * on every replay of such a run (a real step sits at that position, so the marker rewinds).
 * Registered in place of `AgentRunWorkflow` where a test needs to PRODUCE that journal.
 */
@Injectable()
class StagelessJournalWorkflow extends AgentRunWorkflow {
  override run(ctx: WorkflowCtx, input: AgentRunInput): Promise<AgentLoopResult> {
    const older: WorkflowCtx = {
      ...ctx,
      patched: (id) => (id === 'agent:prompt-stages' ? Promise.resolve(false) : ctx.patched(id)),
    };
    return super.run(older, input);
  }
}

async function buildApp(options: {
  shared: Shared;
  stages?: Stages;
  journalPredatingStageSet?: boolean;
}) {
  const stages = options.stages ?? {};
  const builder = Test.createTestingModule({
    imports: [
      DurableModule.forRoot({
        store: options.shared.stateStore,
        transport: new EventEmitterTransport(new EventEmitter2()),
      }),
      AgentModule.forRoot({
        model: options.shared.model,
        store: options.shared.agentStore,
        actorResolver: new HeaderActorResolver(),
        durable: true,
        defaultAgent: 'default',
        ...(stages.memory === true ? { memory: { provider: memoryProvider() } } : {}),
        ...(stages.retrieval === true
          ? { retrieval: { mode: 'inject' as const, retriever: retriever() } }
          : {}),
        ...(stages.skills === true ? { skills: {} } : {}),
      }),
      AgentDurableModule,
    ],
    providers: [PublishTool, DefaultAgent, WeeklyReportSkill],
  });
  const moduleRef = await (options.journalPredatingStageSet === true
    ? builder.overrideProvider(AgentRunWorkflow).useClass(StagelessJournalWorkflow)
    : builder
  ).compile();
  await moduleRef.init();
  return moduleRef;
}

/** Wait until the turn has parked its action tool on a human, which is what makes it approvable. */
async function pendingApproval(store: InMemoryAgentStore): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (store.toolCallRows()[0]?.status === 'pending_approval') {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('the turn never parked its action tool on an approval');
}

async function journal(store: InMemoryStateStore, runId: string): Promise<string[]> {
  return (await store.listCheckpoints(runId))
    .sort((left, right) => left.seq - right.seq)
    .map((checkpoint) => checkpoint.name);
}

function fresh(): Shared {
  return {
    stateStore: new InMemoryStateStore(),
    agentStore: new InMemoryAgentStore(),
    model: new ActionToolModel(),
  };
}

describe('the three optional prompt stages, as a run in flight sees them', () => {
  it('journals the stage set a fresh run resolved, ahead of the stages themselves', async () => {
    const shared = fresh();
    const moduleRef = await buildApp({ shared, stages: { memory: true, skills: true } });
    try {
      const { runId } = await moduleRef
        .get(AgentService)
        .chat({ actor: ACTOR, message: 'have a look' });
      await pendingApproval(shared.agentStore);
      await moduleRef.get(AgentService).approve(ACTOR, 'call-publish');
      const result = await moduleRef
        .get(WorkflowEngine)
        .waitForRun(runId, { timeoutMs: 5000, until: 'terminal' });
      expect(result.status).toBe('completed');

      const names = await journal(shared.stateStore, runId);
      expect(names).toContain('patch:agent:prompt-stages');
      expect(names.indexOf('run:prompt-stages')).toBeLessThan(names.indexOf('memory:digest'));
      expect(names).toContain('skills:catalog');
      // Retrieval was off, so its position is not there to be found.
      expect(names).not.toContain('retrieve');
    } finally {
      await moduleRef.close();
    }
  });

  /**
   * Why `quota:check` is NOT one of the three, pinned so nobody adds it. The only marker position
   * that precedes it is the loop's first, which for a top-level run with no dispatch marker written
   * is the WORKFLOW's first — and that is the one `agent:dispatched-steps` probes. Two different
   * `patch:` markers at one position is the case `ctx.patched` refuses outright instead of
   * rewinding, so a marker here would turn opting into `dispatchedSteps` under a parked run from a
   * safe rewind into a hard replay failure.
   */
  it('leaves the first position to the dispatched-steps marker, spending none of its own', async () => {
    const shared = fresh();
    const moduleRef = await buildApp({ shared });
    try {
      const { runId } = await moduleRef.get(AgentService).chat({ actor: ACTOR, message: 'go' });
      await pendingApproval(shared.agentStore);
      const names = await journal(shared.stateStore, runId);
      expect(names[0]).toBe('persist:user');
    } finally {
      await moduleRef.close();
    }
  });

  /**
   * The constraint that outranks the design: a decision that changes a checkpoint's name, position
   * or count must come from the journal, never from the config of the process that happens to be
   * replaying. This run parks on an approval with all three stages off; the process that resumes it
   * has all three on.
   */
  it('finishes a turn parked before memory, retrieval and skills were switched on', async () => {
    const shared = fresh();
    const first = await buildApp({ shared });
    let runId: string;
    try {
      ({ runId } = await first.get(AgentService).chat({ actor: ACTOR, message: 'go' }));
      await pendingApproval(shared.agentStore);
      const parked = await journal(shared.stateStore, runId);
      expect(parked).not.toContain('memory:digest');
      expect(parked).toContain('llm:0');
    } finally {
      await first.close();
    }

    const second = await buildApp({
      shared,
      stages: { memory: true, retrieval: true, skills: true },
    });
    try {
      await second.get(AgentService).approve(ACTOR, 'call-publish');
      const result = await second
        .get(WorkflowEngine)
        .waitForRun(runId, { timeoutMs: 5000, until: 'terminal' });
      expect(result.status).toBe('completed');
      expect(shared.agentStore.toolCallRows()[0]).toMatchObject({
        toolName: 'publish',
        status: 'executed',
      });

      // None of the three positions appears, because the run's own history says it had none.
      const names = await journal(shared.stateStore, runId);
      expect(names).not.toContain('memory:digest');
      expect(names).not.toContain('retrieve');
      expect(names).not.toContain('skills:catalog');
      // And nothing the newly-enabled stages would have written reached the model either.
      expect(shared.model.prompts.some((prompt) => prompt.includes('kilometres'))).toBe(false);
    } finally {
      await second.close();
    }
  });

  /** The same property in reverse: a stage the run recorded keeps its position once it is taken away. */
  it('finishes a turn parked with memory on after memory is taken away', async () => {
    const shared = fresh();
    const first = await buildApp({ shared, stages: { memory: true } });
    let runId: string;
    try {
      ({ runId } = await first.get(AgentService).chat({ actor: ACTOR, message: 'go' }));
      await pendingApproval(shared.agentStore);
      expect(await journal(shared.stateStore, runId)).toContain('memory:digest');
    } finally {
      await first.close();
    }

    const second = await buildApp({ shared });
    try {
      await second.get(AgentService).approve(ACTOR, 'call-publish');
      const result = await second
        .get(WorkflowEngine)
        .waitForRun(runId, { timeoutMs: 5000, until: 'terminal' });
      expect(result.status).toBe('completed');
      expect(shared.agentStore.toolCallRows()[0]).toMatchObject({ status: 'executed' });
    } finally {
      await second.close();
    }
  });

  /**
   * The deploy of the marker itself. A journal written with no stage set in it is the common case on
   * the release that adds one, and its stages were ON — so the guard has to hand such a run the
   * positions its history holds rather than the empty set, which is why the marker records a
   * property of the BODY and the per-stage answers ride in a checkpoint of their own.
   */
  it('replays a run journaled before the stage set existed on the stages it recorded', async () => {
    const shared = fresh();
    const first = await buildApp({
      shared,
      stages: { memory: true, skills: true },
      journalPredatingStageSet: true,
    });
    let runId: string;
    try {
      ({ runId } = await first.get(AgentService).chat({ actor: ACTOR, message: 'go' }));
      await pendingApproval(shared.agentStore);
      const parked = await journal(shared.stateStore, runId);
      // No marker and no stage set: the rewind spends no position, so such a run's history is
      // untouched by the guard that reads it.
      expect(parked).not.toContain('patch:agent:prompt-stages');
      expect(parked).not.toContain('run:prompt-stages');
      expect(parked).toContain('memory:digest');
    } finally {
      await first.close();
    }

    const second = await buildApp({ shared, stages: { memory: true, skills: true } });
    try {
      await second.get(AgentService).approve(ACTOR, 'call-publish');
      const result = await second
        .get(WorkflowEngine)
        .waitForRun(runId, { timeoutMs: 5000, until: 'terminal' });
      expect(result.status).toBe('completed');
      const names = await journal(shared.stateStore, runId);
      expect(names).not.toContain('patch:agent:prompt-stages');
      expect(names).toContain('memory:digest');
      expect(names).toContain('skills:catalog');
    } finally {
      await second.close();
    }
  });
});
