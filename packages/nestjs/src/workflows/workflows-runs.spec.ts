import type {
  AgentIntake,
  ModelProvider,
  ModelTurnArgs,
  ModelTurnResult,
} from '@dudousxd/nestjs-agent-core';
import {
  FakeModelProvider,
  type FakeScript,
  InMemoryAgentStore,
} from '@dudousxd/nestjs-agent-testing';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { InMemoryWorkflowStore, ManualWorkflowClock, WorkflowsModule } from '@nestjs/workflows';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AgentModule } from '../agent.module.js';
import { Agent } from '../decorator/agent.decorator.js';
import { AiTool } from '../decorator/ai-tool.decorator.js';
import { HeaderActorResolver } from '../resolver/header-actor-resolver.js';
import { AgentWorkflowsModule } from './agent-workflows.module.js';
import { buildWorkflowsApp, collect } from './workflows-app.spec-helper.js';

const ACTOR = { id: 'u1', roles: ['ADMIN'] };
const executed: string[] = [];

@AiTool({
  name: 'purgeCache',
  kind: 'action',
  description: 'purge',
  input: z.object({ key: z.string() }),
})
@Injectable()
class PurgeCacheTool {
  async execute(input: { key: string }) {
    executed.push(input.key);
    return { purged: input.key };
  }
}

@AiTool({ name: 'lookup', kind: 'read', description: 'lookup', input: z.object({ n: z.number() }) })
@Injectable()
class LookupTool {
  async execute(input: { n: number }) {
    executed.push(`lookup-${input.n}`);
    return { n: input.n };
  }
}

@Agent({ name: 'default', systemPrompt: 'default agent', model: 'fake-1' })
@Injectable()
class DefaultAgent {}

/** Counts model calls, so a test can tell a journaled model step from one that ran again. */
class CountingModel extends FakeModelProvider {
  calls = 0;
  override async runTurn(args: ModelTurnArgs): Promise<ModelTurnResult> {
    this.calls += 1;
    return super.runTurn(args);
  }
}

const purgeOnce: FakeScript = (args) =>
  args.messages.at(-1)?.role === 'user'
    ? { text: 'about to purge', toolCall: { name: 'purgeCache', input: { key: 'cfg' } } }
    : { text: 'finished' };

describe('a turn on @nestjs/workflows', () => {
  it('fails at boot, with what to import, when WorkflowsModule or AgentWorkflowsModule is missing', async () => {
    const base = {
      model: new FakeModelProvider(() => ({ text: 'x' })),
      store: new InMemoryAgentStore(),
      actorResolver: new HeaderActorResolver(),
      durable: true as const,
    };
    await expect(
      Test.createTestingModule({
        imports: [AgentModule.forRoot(base), AgentWorkflowsModule],
        providers: [DefaultAgent],
      }).compile(),
    ).rejects.toThrow(/WorkflowsModule\.forRoot\(\)/);
    await expect(
      Test.createTestingModule({
        imports: [WorkflowsModule.forRoot({ worker: false }), AgentModule.forRoot(base)],
        providers: [DefaultAgent],
      }).compile(),
    ).rejects.toThrow(/AgentWorkflowsModule was not found/);
  });

  it('retries a failing model call as a durable step, on the module clock', async () => {
    let failures = 1;
    class FlakyModel implements ModelProvider {
      async runTurn(args: ModelTurnArgs): Promise<ModelTurnResult> {
        if (failures > 0) {
          failures -= 1;
          throw new Error('provider hiccup');
        }
        await args.sink.write(new TextEncoder().encode('ok'));
        return { text: 'ok', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
      }
    }
    const node = await buildWorkflowsApp({ model: new FlakyModel(), providers: [DefaultAgent] });
    try {
      const { runId } = await node.service.chat({ actor: ACTOR, message: 'hi' });
      await node.drain();
      expect((await node.client.getStatus(runId))?.status).toBe('suspended');
      node.clock.advance('1s');
      await node.drain();
      expect((await node.client.getStatus(runId))?.status).toBe('completed');
      const llm = (await node.client.getStatus(runId, { journal: true }))?.journal.find(
        (entry) => entry.name === 'llm:0',
      );
      expect(llm?.attempts).toBe(2);
    } finally {
      await node.close();
    }
  });

  it('cancels a turn parked on a person and settles its thread and stream', async () => {
    executed.length = 0;
    const node = await buildWorkflowsApp({
      model: new FakeModelProvider(purgeOnce),
      providers: [PurgeCacheTool, DefaultAgent],
    });
    try {
      const { runId, threadId } = await node.service.chat({ actor: ACTOR, message: 'purge it' });
      const streamed = collect(node.service.subscribe(runId));
      await node.drain();
      expect(node.agentStore.toolCallRows()[0]?.status).toBe('pending_approval');

      await node.runner.cancel(runId);
      await node.drain();

      expect((await node.client.getStatus(runId))?.status).toBe('cancelled');
      expect(await node.runner.isRunActive(runId)).toBe(false);
      expect(await streamed).toContain('"kind":"cancelled"');
      expect((await node.agentStore.getThread(threadId))?.activeRunId).toBeUndefined();
      expect(executed).toEqual([]);
    } finally {
      await node.close();
    }
  });

  it('runs a turn’s tool calls at the same time, each its own step', async () => {
    let release!: () => void;
    const both = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = 0;
    @AiTool({ name: 'left', kind: 'read', description: 'left', input: z.object({}) })
    @Injectable()
    class LeftTool {
      async execute() {
        started += 1;
        if (started === 2) release();
        await both;
        return { side: 'left' };
      }
    }
    @AiTool({ name: 'right', kind: 'read', description: 'right', input: z.object({}) })
    @Injectable()
    class RightTool {
      async execute() {
        started += 1;
        if (started === 2) release();
        await both;
        return { side: 'right' };
      }
    }
    const node = await buildWorkflowsApp({
      model: new FakeModelProvider((_args, turn) =>
        turn === 0
          ? {
              text: 'both',
              toolCalls: [
                { name: 'left', input: {} },
                { name: 'right', input: {} },
              ],
            }
          : { text: 'done' },
      ),
      providers: [LeftTool, RightTool, DefaultAgent],
    });
    try {
      const { runId } = await node.service.chat({ actor: ACTOR, message: 'go' });
      await node.drain();
      expect((await node.client.getStatus(runId))?.status).toBe('completed');
      const rows = node.agentStore.toolCallRows().map((row) => [row.toolName, row.output]);
      expect(rows).toEqual([
        ['left', { side: 'left' }],
        ['right', { side: 'right' }],
      ]);
      const names = (await node.client.getStatus(runId, { journal: true }))?.journal.map(
        (entry) => entry.name,
      );
      expect(names?.filter((name) => name.startsWith('tool:'))).toHaveLength(2);
    } finally {
      await node.close();
    }
  });

  it('survives a restart: a second process resumes the parked turn without calling the model again', async () => {
    executed.length = 0;
    const agentStore = new InMemoryAgentStore();
    const workflowStore = new InMemoryWorkflowStore();
    const clock = new ManualWorkflowClock();
    const model = new CountingModel(purgeOnce);
    const first = await buildWorkflowsApp({
      model,
      agentStore,
      workflowStore,
      clock,
      providers: [PurgeCacheTool, DefaultAgent],
    });
    const { runId, threadId } = await first.service.chat({ actor: ACTOR, message: 'purge it' });
    await first.drain();
    const callId = agentStore.toolCallRows()[0]?.toolCallId ?? '';
    expect(model.calls).toBe(1);
    await first.close();

    const second = await buildWorkflowsApp({
      model,
      agentStore,
      workflowStore,
      clock,
      providers: [PurgeCacheTool, DefaultAgent],
    });
    try {
      await second.service.approve(ACTOR, callId);
      await second.drain();
      const status = await second.client.getStatus(runId, { journal: true });
      expect(status?.status).toBe('completed');
      // The first model call came back from the journal; only the second one ran here.
      expect(model.calls).toBe(2);
      expect(executed).toEqual(['cfg']);
      expect(status?.runs).toBeGreaterThanOrEqual(2);
      const thread = await agentStore.getThread(threadId);
      expect(thread?.messages.at(-1)?.content).toBe('finished');
      expect(thread?.activeRunId).toBeUndefined();
    } finally {
      await second.close();
    }
  });

  it('goes on in child instances after stepsPerInstance model calls, each journal holding its own segment', async () => {
    executed.length = 0;
    const model = new CountingModel((_args, turn) =>
      turn < 4
        ? { text: `step ${turn}`, toolCall: { name: 'lookup', input: { n: turn } } }
        : { text: 'all looked up' },
    );
    const node = await buildWorkflowsApp({
      model,
      durable: { stepsPerInstance: 2 },
      providers: [LookupTool, DefaultAgent],
    });
    try {
      const { runId, threadId } = await node.service.chat({ actor: ACTOR, message: 'go' });
      const streamed = collect(node.service.subscribe(runId));
      await node.drain();

      const root = await node.client.getStatus(runId, { journal: true, children: true });
      expect(root?.status).toBe('completed');
      expect((root?.output as { text?: string } | undefined)?.text).toBe('all looked up');
      expect(model.calls).toBe(5);
      expect(executed).toEqual(['lookup-0', 'lookup-1', 'lookup-2', 'lookup-3']);

      const segments = [runId, `${runId}~1`, `${runId}~2`];
      for (const id of segments) {
        const details = await node.client.getStatus(id, { journal: true });
        const models = details?.journal.filter((entry) => entry.name.startsWith('llm:')) ?? [];
        expect(models.length).toBeLessThanOrEqual(2);
        expect(details?.status).toBe('completed');
      }
      expect(await node.client.getStatus(`${runId}~3`)).toBeNull();
      expect(await streamed).toContain('all looked up');
      const thread = await node.agentStore.getThread(threadId);
      expect(thread?.activeRunId).toBeUndefined();
      expect(thread?.messages.at(-1)?.content).toBe('all looked up');
    } finally {
      await node.close();
    }
  });
});

describe('delegation on @nestjs/workflows', () => {
  @Agent({ name: 'research', systemPrompt: 'research worker', tools: ['purgeCache'] })
  @Injectable()
  class ResearchAgent {}

  @Agent({ name: 'orch', systemPrompt: 'orchestrator', handoff: [ResearchAgent] })
  @Injectable()
  class OrchestratorAgent {}

  @Agent({
    name: 'orch-detached',
    systemPrompt: 'orchestrator',
    handoff: [{ agent: ResearchAgent, detached: true }],
  })
  @Injectable()
  class DetachedOrchestrator {}

  const script =
    (tool: string): FakeScript =>
    (args, turnIndex) => {
      if (args.system.includes('research worker')) {
        return turnIndex === 0
          ? { text: 'digging', toolCall: { name: 'purgeCache', input: { key: 'cfg' } } }
          : { text: 'RESEARCH ANSWER' };
      }
      if (turnIndex === 0) {
        return { text: 'delegating', toolCall: { name: tool, input: { task: 'dig into it' } } };
      }
      return { text: 'orchestrator done' };
    };

  async function app(tool: string, defaultAgent: string) {
    const node = await buildWorkflowsApp({
      model: new FakeModelProvider(script(tool)),
      providers: [PurgeCacheTool, ResearchAgent, OrchestratorAgent, DetachedOrchestrator],
    });
    return { node, defaultAgent };
  }

  it('runs an awaited sub-agent as a child workflow, whose approval reaches it through the parent', async () => {
    executed.length = 0;
    const { node } = await app('ask_research', 'orch');
    try {
      const { runId } = await node.service.chat({
        actor: ACTOR,
        message: 'look',
        agentName: 'orch',
      });
      await node.drain();
      const row = node.agentStore.toolCallRows().find((each) => each.toolName === 'purgeCache');
      expect(row?.status).toBe('pending_approval');
      expect(row?.runId).not.toBe(runId);
      // The parent waits on its child, and the child's call shows under the parent.
      const pending = await node.runner.pendingReplies(runId);
      expect(pending.map((reply) => reply.toolCallId)).toEqual([row?.toolCallId]);
      expect((await node.client.getStatus(runId, { children: true }))?.children).toHaveLength(1);

      await node.service.approve(ACTOR, row?.toolCallId ?? '');
      await node.drain();
      expect((await node.client.getStatus(runId))?.status).toBe('completed');
      expect(executed).toEqual(['cfg']);
      const delegation = node.agentStore
        .toolCallRows()
        .find((each) => each.toolName === 'ask_research');
      expect(JSON.stringify(delegation?.output)).toContain('RESEARCH ANSWER');
    } finally {
      await node.close();
    }
  });

  it('starts a detached sub-agent as an abandoned child: the turn ends, a Stop on it does not reach the child', async () => {
    executed.length = 0;
    const { node } = await app('start_research', 'orch-detached');
    try {
      const { runId, threadId } = await node.service.chat({
        actor: ACTOR,
        message: 'look',
        agentName: 'orch-detached',
      });
      await node.drain();
      expect((await node.client.getStatus(runId))?.status).toBe('completed');
      const row = node.agentStore.toolCallRows().find((each) => each.toolName === 'purgeCache');
      expect(row?.status).toBe('pending_approval');
      const childRunId = row?.runId ?? '';
      const child = await node.client.getStatus(childRunId);
      expect(child).toMatchObject({ parentId: runId, parentClose: 'abandon', status: 'suspended' });

      await node.runner.cancel(runId);
      expect((await node.client.getStatus(childRunId))?.status).toBe('suspended');

      await node.service.approve(ACTOR, row?.toolCallId ?? '');
      await node.drain();
      expect((await node.client.getStatus(childRunId))?.status).toBe('completed');
      const thread = await node.agentStore.getThread(threadId);
      expect(thread?.messages.map((message) => message.content)).toContain('RESEARCH ANSWER');
    } finally {
      await node.close();
    }
  });
});

describe('the chat queue and elicitation on @nestjs/workflows', () => {
  it('starts the next queued message as an abandoned child when the running turn completes', async () => {
    const node = await buildWorkflowsApp({
      model: new FakeModelProvider((args) => ({
        text: `re: ${[...args.messages].reverse().find((m) => m.role === 'user')?.content ?? ''}`,
      })),
      providers: [DefaultAgent],
    });
    try {
      const thread = await node.agentStore.createThread({ actor: ACTOR });
      const first = (await node.service.send({
        actor: ACTOR,
        threadId: thread.id,
        message: 'first',
      })) as { runId: string };
      const queued = (await node.service.send({
        actor: ACTOR,
        threadId: thread.id,
        message: 'second',
      })) as { queued: boolean; messageId: string };
      expect(queued.queued).toBe(true);

      await node.drain();
      expect((await node.client.getStatus(first.runId))?.status).toBe('completed');
      const next = await node.client.getStatus(queued.messageId);
      expect(next).toMatchObject({
        status: 'completed',
        parentId: first.runId,
        parentClose: 'abandon',
      });
      const messages = (await node.agentStore.getThread(thread.id))?.messages ?? [];
      expect(messages.map((message) => `${message.role}: ${message.content}`)).toEqual([
        'user: first',
        'assistant: re: first',
        'user: second',
        'assistant: re: second',
      ]);
    } finally {
      await node.close();
    }
  });

  it('parks a configured intake on a reply signal and finishes on the answers', async () => {
    const INTAKE: AgentIntake = {
      preamble: 'One question before I start.',
      questions: [
        {
          id: 'scope',
          prompt: 'How much should I cover?',
          options: [
            { value: 'file', label: 'This file' },
            { value: 'module', label: 'The whole module' },
          ],
          defaults: ['module'],
        },
      ],
    };
    @Agent({ name: 'default', systemPrompt: 'intake agent', intake: INTAKE })
    @Injectable()
    class IntakeAgent {}
    const model = new CountingModel(() => ({ text: 'done' }));
    const node = await buildWorkflowsApp({ model, providers: [IntakeAgent] });
    try {
      const { runId } = await node.service.chat({ actor: ACTOR, message: 'refactor' });
      await node.drain();
      expect(model.calls).toBe(0);
      expect(await node.runner.pendingReplies(runId)).toMatchObject([
        { toolCallId: `intake-${runId}`, kind: 'elicitation' },
      ]);
      await node.service.answer(ACTOR, `intake-${runId}`, { scope: ['file'] });
      await node.drain();
      expect((await node.client.getStatus(runId))?.status).toBe('completed');
      expect(node.agentStore.toolCallRows()[0]).toMatchObject({
        status: 'executed',
        output: { answers: { scope: ['file'] }, skipped: false },
      });
      expect(model.calls).toBe(1);
    } finally {
      await node.close();
    }
  });
});
