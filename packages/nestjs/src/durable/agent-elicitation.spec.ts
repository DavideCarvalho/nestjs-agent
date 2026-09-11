import type {
  AgentIntake,
  ModelProvider,
  ModelTurnArgs,
  ModelTurnResult,
} from '@dudousxd/nestjs-agent-core';
import { InMemoryAgentStore } from '@dudousxd/nestjs-agent-testing';
import { DurableModule } from '@dudousxd/nestjs-durable';
import { InMemoryStateStore, WorkflowEngine } from '@dudousxd/nestjs-durable-core';
import { EventEmitterTransport } from '@dudousxd/nestjs-durable-transport-event-emitter';
import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { AgentModule } from '../agent.module.js';
import { AgentService } from '../agent.service.js';
import { Agent } from '../decorator/agent.decorator.js';
import { AgentDurableModule } from './agent-durable.module.js';

const ACTOR = { id: 'u1', roles: ['ADMIN'] };

const INTAKE: AgentIntake = {
  preamble: 'Two questions before I start.',
  questions: [
    {
      id: 'scope',
      prompt: 'How much should I cover?',
      options: [
        { value: 'file', label: 'This file', hotkey: 'a' },
        { value: 'module', label: 'The whole module', hotkey: 'b' },
      ],
      defaults: ['module'],
    },
    {
      id: 'tests',
      prompt: 'Which tests?',
      multiple: true,
      options: [
        { value: 'unit', label: 'Unit' },
        { value: 'e2e', label: 'End to end' },
      ],
      defaults: ['unit'],
    },
  ],
};

/** Answers in prose, and reports back what it was told, so the test can read the transcript. */
class ProseModel implements ModelProvider {
  readonly prompts: ModelTurnArgs[] = [];

  async runTurn(args: ModelTurnArgs): Promise<ModelTurnResult> {
    this.prompts.push(args);
    await args.sink.write(new TextEncoder().encode('done'));
    return { text: 'done', toolCalls: [], usage: { inputTokens: 1, outputTokens: 4 } };
  }
}

/** Calls `ask` on its first step, then answers. */
class AskingModel implements ModelProvider {
  readonly toolNames: string[][] = [];

  async runTurn(args: ModelTurnArgs): Promise<ModelTurnResult> {
    this.toolNames.push(args.tools.map((tool) => tool.name));
    const turnIndex = args.messages.filter((message) => message.role === 'assistant').length;
    const text = turnIndex === 0 ? 'need scope' : 'done';
    await args.sink.write(new TextEncoder().encode(text));
    return {
      text,
      toolCalls:
        turnIndex === 0
          ? [
              {
                id: 'call-ask',
                name: 'ask',
                input: {
                  preamble: 'One question first.',
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
                },
              },
            ]
          : [],
      usage: { inputTokens: 1, outputTokens: text.length },
    };
  }
}

@Agent({ name: 'intake-agent', systemPrompt: 'intake test agent', intake: INTAKE })
@Injectable()
class IntakeAgent {}

@Agent({ name: 'asking-agent', systemPrompt: 'ask test agent', ask: true })
@Injectable()
class AskingAgent {}

/**
 * Wait for the run to actually park ON THE QUESTION SET. `waitForRun(…, 'suspended')` matches the
 * FIRST suspend, which under dispatched steps is the model step, not the elicitation.
 */
async function waitForPending(store: InMemoryAgentStore, toolCallId: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const row = store.toolCallRows().find((each) => each.toolCallId === toolCallId);
    if (row?.status === 'pending_approval') {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`tool call ${toolCallId} never reached pending_approval`);
}

async function buildApp(model: ModelProvider, defaultAgent: string) {
  const stateStore = new InMemoryStateStore();
  const agentStore = new InMemoryAgentStore();
  const moduleRef = await Test.createTestingModule({
    imports: [
      DurableModule.forRoot({
        store: stateStore,
        transport: new EventEmitterTransport(new EventEmitter2()),
      }),
      AgentModule.forRoot({ model, store: agentStore, durable: true, defaultAgent }),
      AgentDurableModule,
    ],
    providers: [IntakeAgent, AskingAgent],
  }).compile();
  await moduleRef.init();
  return { moduleRef, stateStore, agentStore };
}

describe('elicitation survives a real suspend and resume', () => {
  it('parks a configured intake on a signal and finishes on the answers a second call delivers', async () => {
    const model = new ProseModel();
    const { moduleRef, stateStore, agentStore } = await buildApp(model, 'intake-agent');
    try {
      const service = moduleRef.get(AgentService);
      const engine = moduleRef.get(WorkflowEngine);
      const { runId } = await service.chat({ actor: ACTOR, message: 'refactor this' });

      // The run really is parked, and the model has not been called at all — the intake sits ahead
      // of the first turn, so it costs nothing to produce.
      await waitForPending(agentStore, `intake-${runId}`);
      await engine.waitForRun(runId, { timeoutMs: 5000, until: 'suspended' });
      expect(model.prompts).toHaveLength(0);
      const pending = agentStore.toolCallRows();
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({
        toolCallId: `intake-${runId}`,
        toolName: 'ask',
        toolType: 'action',
        status: 'pending_approval',
      });

      await service.answer(ACTOR, `intake-${runId}`, { scope: ['file'] });

      const result = await engine.waitForRun(runId, { timeoutMs: 5000, until: 'terminal' });
      expect(result.status).toBe('completed');
      expect(agentStore.toolCallRows()[0]).toMatchObject({
        status: 'executed',
        output: {
          answers: { scope: ['file'], tests: ['unit'] },
          skipped: false,
          defaulted: ['tests'],
        },
      });

      // The answers reached the model as an ordinary tool round-trip, by label rather than by the
      // opaque option values.
      const transcript = JSON.stringify(model.prompts[0]?.messages ?? []);
      expect(transcript).toContain('This file');
      expect(transcript).toContain('Two questions before I start.');

      const journal = (await stateStore.listCheckpoints(runId))
        .sort((left, right) => left.seq - right.seq)
        .map((checkpoint) => checkpoint.name);
      expect(journal).toContain('intake:ask');
      expect(journal).toContain('intake:answers');
      // Settled before the turn's first model step opens — the whole point of an INTAKE.
      expect(journal.indexOf('intake:answers')).toBeLessThan(
        journal.indexOf('stream:step-start:0'),
      );
    } finally {
      await moduleRef.close();
    }
  });

  it('records a skipped intake as a rejection and still proceeds on the pre-picked answers', async () => {
    const model = new ProseModel();
    const { moduleRef, agentStore } = await buildApp(model, 'intake-agent');
    try {
      const service = moduleRef.get(AgentService);
      const engine = moduleRef.get(WorkflowEngine);
      const { runId } = await service.chat({ actor: ACTOR, message: 'refactor this' });
      await waitForPending(agentStore, `intake-${runId}`);

      await service.skip(ACTOR, `intake-${runId}`);

      expect((await engine.waitForRun(runId, { timeoutMs: 5000, until: 'terminal' })).status).toBe(
        'completed',
      );
      expect(agentStore.toolCallRows()[0]).toMatchObject({
        status: 'rejected',
        error: 'skipped by the user',
        output: { answers: { scope: ['module'], tests: ['unit'] }, skipped: true },
      });
      expect(JSON.stringify(model.prompts[0]?.messages ?? [])).toContain('declined to answer');
    } finally {
      await moduleRef.close();
    }
  });

  it('takes the pre-picked answers when the user submits nothing', async () => {
    const model = new ProseModel();
    const { moduleRef, agentStore } = await buildApp(model, 'intake-agent');
    try {
      const service = moduleRef.get(AgentService);
      const engine = moduleRef.get(WorkflowEngine);
      const { runId } = await service.chat({ actor: ACTOR, message: 'refactor this' });
      await waitForPending(agentStore, `intake-${runId}`);

      await service.answer(ACTOR, `intake-${runId}`);

      expect((await engine.waitForRun(runId, { timeoutMs: 5000, until: 'terminal' })).status).toBe(
        'completed',
      );
      expect(agentStore.toolCallRows()[0]).toMatchObject({
        status: 'executed',
        output: {
          answers: { scope: ['module'], tests: ['unit'] },
          skipped: false,
          defaulted: ['scope', 'tests'],
        },
      });
    } finally {
      await moduleRef.close();
    }
  });

  it('parks the model’s own ask on the same signal, through the same endpoint', async () => {
    const model = new AskingModel();
    const { moduleRef, stateStore, agentStore } = await buildApp(model, 'asking-agent');
    try {
      const service = moduleRef.get(AgentService);
      const engine = moduleRef.get(WorkflowEngine);
      const { runId } = await service.chat({ actor: ACTOR, message: 'refactor this' });
      await waitForPending(agentStore, 'call-ask');

      // The tool reached the model even though nothing registered it.
      expect(model.toolNames[0]).toContain('ask');
      expect(agentStore.toolCallRows()[0]).toMatchObject({
        toolCallId: 'call-ask',
        toolName: 'ask',
        toolType: 'action',
        status: 'pending_approval',
      });

      await service.answer(ACTOR, 'call-ask', { scope: ['file'] });

      expect((await engine.waitForRun(runId, { timeoutMs: 5000, until: 'terminal' })).status).toBe(
        'completed',
      );
      expect(agentStore.toolCallRows()[0]).toMatchObject({
        status: 'executed',
        output: { answers: { scope: ['file'] }, skipped: false },
      });

      const journal = (await stateStore.listCheckpoints(runId))
        .sort((left, right) => left.seq - right.seq)
        .map((checkpoint) => checkpoint.name);
      expect(journal).toContain('persist:toolcall:call-ask');
      expect(journal).toContain('stream:elicitation:call-ask');
      expect(journal).toContain('persist:toolexec:call-ask');
      // Never dispatched as a tool execution: there is nothing to execute.
      expect(journal).not.toContain('tool:call-ask');
    } finally {
      await moduleRef.close();
    }
  });

  it('leaves a run that configures neither surface with the journal it always had', async () => {
    const model = new ProseModel();
    const { moduleRef, stateStore } = await buildApp(model, 'default');
    try {
      const service = moduleRef.get(AgentService);
      const engine = moduleRef.get(WorkflowEngine);
      const { runId } = await service.chat({ actor: ACTOR, message: 'hi' });
      await engine.waitForRun(runId, { timeoutMs: 5000, until: 'terminal' });

      const journal = (await stateStore.listCheckpoints(runId)).map((c) => c.name);
      expect(journal.filter((name) => name.startsWith('intake:'))).toEqual([]);
      expect(journal.filter((name) => name.startsWith('stream:elicitation'))).toEqual([]);
      expect(model.prompts[0]?.tools.map((tool) => tool.name)).toEqual([]);
    } finally {
      await moduleRef.close();
    }
  });
});
