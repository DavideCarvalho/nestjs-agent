import type { ModelProvider, ModelTurnArgs, ModelTurnResult } from '@dudousxd/nestjs-agent-core';
import { InMemoryAgentStore } from '@dudousxd/nestjs-agent-testing';
import { DurableModule } from '@dudousxd/nestjs-durable';
import { InMemoryStateStore, WorkflowEngine } from '@dudousxd/nestjs-durable-core';
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

async function buildApp(
  dispatchedSteps: boolean,
  shared?: { stateStore: InMemoryStateStore; agentStore: InMemoryAgentStore; model: ModelProvider },
) {
  const stateStore = shared?.stateStore ?? new InMemoryStateStore();
  const agentStore = shared?.agentStore ?? new InMemoryAgentStore();
  const moduleRef = await Test.createTestingModule({
    imports: [
      DurableModule.forRoot({
        store: stateStore,
        transport: new EventEmitterTransport(new EventEmitter2()),
      }),
      AgentModule.forRoot({
        model: shared?.model ?? new OneToolModel(),
        store: agentStore,
        actorResolver: new HeaderActorResolver(),
        durable: true,
        defaultAgent: 'default',
        dispatchedSteps,
      }),
      AgentDurableModule,
    ],
    providers: [PeekTool, CommitTool, DefaultAgent],
  }).compile();
  await moduleRef.init();
  return { moduleRef, stateStore, agentStore };
}

describe('dispatched steps under the durable runner', () => {
  it('provides AgentRunSteps under the full wiring, so the routed group has a server', async () => {
    const { moduleRef } = await buildApp(true);
    try {
      // The workflow dispatches by name and never holds this instance; what matters is that the
      // full wiring registers the handler, or the group it routes to would go unserved.
      expect(moduleRef.get(AgentRunSteps)).toBeInstanceOf(AgentRunSteps);
    } finally {
      await moduleRef.close();
    }
  });

  it('journals the routed step groups, not the in-process checkpoint names', async () => {
    const { moduleRef, stateStore } = await buildApp(true);
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

  it('leaves the journal untouched where the deployment does not dispatch', async () => {
    const { moduleRef, stateStore } = await buildApp(false);
    try {
      const { runId } = await moduleRef
        .get(AgentService)
        .chat({ actor: ACTOR, message: 'have a look' });
      const engine = moduleRef.get(WorkflowEngine);
      await engine.waitForRun(runId, { timeoutMs: 5000, until: 'terminal' });

      const journal = (await stateStore.listCheckpoints(runId))
        .sort((left, right) => left.seq - right.seq)
        .map((checkpoint) => checkpoint.name);

      // No marker is spent on a deployment that could never take the dispatched branch anyway.
      expect(journal).not.toContain('patch:agent:dispatched-steps');
      expect(journal).toContain('llm:0');
      expect(journal).toContain('tool:call-peek');
    } finally {
      await moduleRef.close();
    }
  });

  it('finishes a turn parked before dispatch existed on the shape it started with', async () => {
    const stateStore = new InMemoryStateStore();
    const agentStore = new InMemoryAgentStore();
    const model = new ActionToolModel();

    // First process: no dispatch. The turn parks on the action tool's approval signal, having
    // journaled the in-process names.
    const first = await buildApp(false, { stateStore, agentStore, model });
    let runId: string;
    try {
      ({ runId } = await first.moduleRef.get(AgentService).chat({ actor: ACTOR, message: 'go' }));
      await first.moduleRef
        .get(WorkflowEngine)
        .waitForRun(runId, { timeoutMs: 5000, until: 'settled' });
      expect((await stateStore.listCheckpoints(runId)).map((c) => c.name)).toContain('llm:0');
    } finally {
      await first.moduleRef.close();
    }

    // Second process: dispatch on. Approving resumes the SAME run, which must not switch shape
    // mid-flight — the routed names would land at positions the history recorded under others.
    const second = await buildApp(true, { stateStore, agentStore, model });
    try {
      await second.moduleRef.get(AgentService).approve(ACTOR, 'call-commit');
      const result = await second.moduleRef
        .get(WorkflowEngine)
        .waitForRun(runId, { timeoutMs: 5000, until: 'terminal' });
      expect(result.status).toBe('completed');

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
