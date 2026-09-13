import type {
  AgentLoopResult,
  AgentRunInput,
  ModelProvider,
  ModelTurnArgs,
  ModelTurnResult,
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
import { HeaderActorResolver } from '../resolver/header-actor-resolver.js';
import { AgentDurableModule } from './agent-durable.module.js';
import { AgentRunSteps } from './agent-run.steps.js';
import { AgentRunWorkflow } from './agent-run.workflow.js';

const ACTOR = { id: 'u1', roles: ['ADMIN'] };

@AiTool({ name: 'peek', kind: 'read', description: 'peek', input: z.object({}) })
@Injectable()
class PeekTool {
  async execute(): Promise<{ seen: boolean }> {
    return { seen: true };
  }
}

/** An action tool, so a turn can be parked on its approval signal and resumed by a second process. */
@AiTool({ name: 'commit', kind: 'action', description: 'commit', input: z.object({}) })
@Injectable()
class CommitTool {
  async execute(): Promise<{ committed: boolean }> {
    return { committed: true };
  }
}

@Agent({ name: 'default', systemPrompt: 'dispatch test agent', model: 'fake-1' })
@Injectable()
class DefaultAgent {}

class ActionToolModel implements ModelProvider {
  async runTurn(args: ModelTurnArgs): Promise<ModelTurnResult> {
    const turnIndex = args.messages.filter((message) => message.role === 'assistant').length;
    const text = turnIndex === 0 ? 'about to commit' : 'committed';
    await args.sink.write(new TextEncoder().encode(text));
    return {
      text,
      toolCalls: turnIndex === 0 ? [{ id: 'call-commit', name: 'commit', input: {} }] : [],
      usage: { inputTokens: args.messages.length, outputTokens: text.length },
    };
  }
}

class OneToolModel implements ModelProvider {
  async runTurn(args: ModelTurnArgs): Promise<ModelTurnResult> {
    const turnIndex = args.messages.filter((message) => message.role === 'assistant').length;
    const text = turnIndex === 0 ? 'peeking' : 'done';
    await args.sink.write(new TextEncoder().encode(text));
    return {
      text,
      toolCalls: turnIndex === 0 ? [{ id: 'call-peek', name: 'peek', input: {} }] : [],
      usage: { inputTokens: args.messages.length, outputTokens: text.length },
    };
  }
}

/**
 * The `agent.run` body as a release that ran the two long steps in-process journaled it:
 * `ctx.patched('agent:dispatched-steps')` answers `false` without consuming a position, which is
 * exactly what the real `ctx.patched` answers on every replay of such a run (its first position
 * holds a real step, so the marker rewinds). Registered in place of `AgentRunWorkflow` where a test
 * needs to PRODUCE that journal — there is no configuration that writes it any more.
 */
@Injectable()
class InProcessJournalWorkflow extends AgentRunWorkflow {
  override run(ctx: WorkflowCtx, input: AgentRunInput): Promise<AgentLoopResult> {
    const legacy: WorkflowCtx = {
      ...ctx,
      patched: (id) => (id === 'agent:dispatched-steps' ? Promise.resolve(false) : ctx.patched(id)),
    };
    return super.run(legacy, input);
  }
}

async function buildApp(options?: {
  shared?: { stateStore: InMemoryStateStore; agentStore: InMemoryAgentStore; model: ModelProvider };
  journalPredatingDispatch?: boolean;
}) {
  const stateStore = options?.shared?.stateStore ?? new InMemoryStateStore();
  const agentStore = options?.shared?.agentStore ?? new InMemoryAgentStore();
  const builder = Test.createTestingModule({
    imports: [
      DurableModule.forRoot({
        store: stateStore,
        transport: new EventEmitterTransport(new EventEmitter2()),
      }),
      AgentModule.forRoot({
        model: options?.shared?.model ?? new OneToolModel(),
        store: agentStore,
        actorResolver: new HeaderActorResolver(),
        durable: true,
        defaultAgent: 'default',
      }),
      AgentDurableModule,
    ],
    providers: [PeekTool, CommitTool, DefaultAgent],
  });
  const moduleRef = await (options?.journalPredatingDispatch === true
    ? builder.overrideProvider(AgentRunWorkflow).useClass(InProcessJournalWorkflow)
    : builder
  ).compile();
  await moduleRef.init();
  return { moduleRef, stateStore, agentStore };
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

describe('a turn\u2019s long steps are dispatched, because that is what ctx.step means', () => {
  it('provides AgentRunSteps under the full wiring, so the routed group has a server', async () => {
    const { moduleRef } = await buildApp();
    try {
      // The workflow dispatches by name and never holds this instance; what matters is that the
      // full wiring registers the handler, or the group it routes to would go unserved.
      expect(moduleRef.get(AgentRunSteps)).toBeInstanceOf(AgentRunSteps);
    } finally {
      await moduleRef.close();
    }
  });

  /**
   * The handler is the process that builds the tool list the model chooses from, so it is the one
   * that certainly knows each call's kind — and the loop reading its result back may be a pod that
   * registers no tool classes at all. Stamping the kinds onto the result is what carries the
   * approval branch across that hop instead of leaving it to the reader's own registry.
   */
  it('stamps each returned call with the kind of the tool it just offered', async () => {
    const { moduleRef } = await buildApp({
      shared: {
        stateStore: new InMemoryStateStore(),
        agentStore: new InMemoryAgentStore(),
        model: new ActionToolModel(),
      },
    });
    try {
      const turn = await moduleRef.get(AgentRunSteps).llm({
        system: 'dispatch test agent',
        messages: [{ role: 'user', content: 'go' }],
        actor: ACTOR,
        runId: 'run-stamp',
        step: 0,
        sinkRunId: 'run-stamp',
        childSink: false,
      });
      expect(turn.toolCalls).toEqual([
        { id: 'call-commit', name: 'commit', input: {}, kind: 'action' },
      ]);
    } finally {
      await moduleRef.close();
    }
  });

  it('journals the routed step groups, not the in-process checkpoint names', async () => {
    const { moduleRef, stateStore } = await buildApp();
    try {
      const { runId } = await moduleRef
        .get(AgentService)
        .chat({ actor: ACTOR, message: 'have a look' });
      const engine = moduleRef.get(WorkflowEngine);
      const result = await engine.waitForRun(runId, { timeoutMs: 5000, until: 'terminal' });
      expect(result.status).toBe('completed');

      const journal = (await stateStore.listCheckpoints(runId))
        .sort((left, right) => left.seq - right.seq)
        .map((checkpoint) => checkpoint.name);

      expect(journal[0]).toBe('patch:agent:dispatched-steps');
      expect(journal).not.toContain('llm:0');
      expect(journal).not.toContain('tool:call-peek');
    } finally {
      await moduleRef.close();
    }
  });

  /**
   * The approved tool is where dispatch costs a host most, so it gets its own end-to-end pass: the
   * human's decision reaches a run parked on a signal, and the tool it approved executes in the
   * routed group rather than in the body that asked. A handler that cannot rebuild its execution
   * context there fails the call, the model is handed the error, and the turn completes \u2014 an
   * approval spent on an action that never happened, which is why `@AiTool` handlers carry
   * `@CreateRequestContext` exactly as `@Step` handlers do.
   */
  it('dispatches an approved action tool too, and records it executed', async () => {
    const stateStore = new InMemoryStateStore();
    const agentStore = new InMemoryAgentStore();
    const { moduleRef } = await buildApp({
      shared: { stateStore, agentStore, model: new ActionToolModel() },
    });
    try {
      const service = moduleRef.get(AgentService);
      const engine = moduleRef.get(WorkflowEngine);
      const { runId } = await service.chat({ actor: ACTOR, message: 'go' });
      // Polled on the ROW, not the run: a dispatched turn suspends at every transport hop, so the
      // run's own status cannot say whether the call has reached a human yet.
      await pendingApproval(agentStore);

      await service.approve(ACTOR, 'call-commit');
      const result = await engine.waitForRun(runId, { timeoutMs: 5000, until: 'terminal' });
      expect(result.status).toBe('completed');
      expect(agentStore.toolCallRows()[0]).toMatchObject({
        toolName: 'commit',
        status: 'executed',
      });

      const journal = (await stateStore.listCheckpoints(runId))
        .sort((left, right) => left.seq - right.seq)
        .map((checkpoint) => checkpoint.name);
      expect(journal[0]).toBe('patch:agent:dispatched-steps');
      expect(journal).not.toContain('tool:call-commit');
    } finally {
      await moduleRef.close();
    }
  });

  it('replays a run journaled before dispatch on the in-process names it holds', async () => {
    const { moduleRef, stateStore } = await buildApp({ journalPredatingDispatch: true });
    try {
      const { runId } = await moduleRef
        .get(AgentService)
        .chat({ actor: ACTOR, message: 'have a look' });
      const engine = moduleRef.get(WorkflowEngine);
      await engine.waitForRun(runId, { timeoutMs: 5000, until: 'terminal' });

      const journal = (await stateStore.listCheckpoints(runId))
        .sort((left, right) => left.seq - right.seq)
        .map((checkpoint) => checkpoint.name);

      // No marker: the rewind spends no position, so such a run's history is untouched by the
      // guard that reads it.
      expect(journal).not.toContain('patch:agent:dispatched-steps');
      expect(journal).toContain('llm:0');
      expect(journal).toContain('tool:call-peek');
    } finally {
      await moduleRef.close();
    }
  });

  /**
   * The constraint that outranks the design: a decision that changes a checkpoint's name, position
   * or count must come from the journal, never from the code that happens to be replaying. This run
   * is half-finished under the in-process names when the process that wrote them goes away, and the
   * process that resumes it dispatches everything it starts.
   */
  it('finishes a turn parked before dispatch existed on the shape it started with', async () => {
    const stateStore = new InMemoryStateStore();
    const agentStore = new InMemoryAgentStore();
    const model = new ActionToolModel();
    const shared = { stateStore, agentStore, model };

    // First process: the body that ran its model call in-process. The turn parks on the action
    // tool's approval signal, having journaled `llm:0` where the routed group now sits.
    const first = await buildApp({ shared, journalPredatingDispatch: true });
    let runId: string;
    try {
      ({ runId } = await first.moduleRef.get(AgentService).chat({ actor: ACTOR, message: 'go' }));
      await pendingApproval(agentStore);
      expect((await stateStore.listCheckpoints(runId)).map((c) => c.name)).toContain('llm:0');
    } finally {
      await first.moduleRef.close();
    }

    // Second process: today's body, which dispatches. Approving resumes the SAME run, which must
    // not switch shape mid-flight — the routed names would land at positions the history recorded
    // under others, and the resume would die a NonDeterminismError instead of answering.
    const second = await buildApp({ shared });
    try {
      await second.moduleRef.get(AgentService).approve(ACTOR, 'call-commit');
      const result = await second.moduleRef
        .get(WorkflowEngine)
        .waitForRun(runId, { timeoutMs: 5000, until: 'terminal' });
      expect(result.status).toBe('completed');
      expect(agentStore.toolCallRows()[0]).toMatchObject({
        toolName: 'commit',
        status: 'executed',
      });

      const journal = (await stateStore.listCheckpoints(runId))
        .sort((left, right) => left.seq - right.seq)
        .map((checkpoint) => checkpoint.name);
      expect(journal).not.toContain('patch:agent:dispatched-steps');
      expect(journal).toContain('llm:0');
      expect(journal).toContain('tool:call-commit');
    } finally {
      await second.moduleRef.close();
    }
  });
});
