import {
  FakeModelProvider,
  type FakeScript,
  InMemoryAgentStore,
} from '@dudousxd/nestjs-agent-testing';
import { DurableModule, Workflow } from '@dudousxd/nestjs-durable';
import {
  DurableWorkflow,
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

/**
 * A tool that starts a workflow of the app's own — `SomeWorkflow.start(...)`, reached through
 * whatever service the tool calls. A class-first static routes by the ambient workflow ctx, so where
 * the tool's body runs on the agent run's own async path the start becomes `ctx.startChild`: a
 * `spawn:<id>` checkpoint in the AGENT run's journal, written from inside a step body. A replay
 * skips a completed step's body, never asks for that position, and offers it to the next checkpoint
 * the loop wants — which the runtime refuses as non-determinism. It takes a resume AFTER such a tool
 * to see it: a second action awaiting approval in the same step.
 */

const ingested: string[] = [];

@Injectable()
@Workflow({ name: 'test.ingest', version: '1' })
class IngestWorkflow extends DurableWorkflow {
  async run(ctx: WorkflowCtx, input: { examId: string }): Promise<{ ok: true }> {
    await ctx.localStep('ingest', async () => {
      ingested.push(input.examId);
    });
    return { ok: true };
  }
}

const executions: Record<string, number> = {};

@AiTool({
  name: 'saveExam',
  kind: 'action',
  description: 'saves the exam and queues its ingest',
  input: z.object({ examId: z.string() }),
})
@Injectable()
class SaveExamTool {
  async execute(input: { examId: string }) {
    executions.saveExam = (executions.saveExam ?? 0) + 1;
    const { runId } = await IngestWorkflow.start(
      { examId: input.examId },
      { id: `ingest-${input.examId}` },
    );
    return { saved: true, ingestRunId: runId };
  }
}

@AiTool({
  name: 'recordMeasure',
  kind: 'action',
  description: 'records a measure',
  input: z.object({ value: z.number() }),
})
@Injectable()
class RecordMeasureTool {
  async execute() {
    executions.recordMeasure = (executions.recordMeasure ?? 0) + 1;
    return { recorded: true };
  }
}

@Agent({ name: 'default', systemPrompt: 'agent', model: 'fake-1' })
@Injectable()
class DefaultAgent {}

const ACTOR = { id: 'u1', roles: ['ADMIN'] };

const twoActions: FakeScript = (args) =>
  args.messages.at(-1)?.role === 'user' && args.messages.at(-1)?.content !== ''
    ? {
        text: 'saving',
        toolCalls: [
          { name: 'saveExam', input: { examId: 'e1' } },
          { name: 'recordMeasure', input: { value: 7 } },
        ],
      }
    : { text: 'done' };

async function buildApp() {
  const store = new InMemoryAgentStore();
  const journal = new InMemoryStateStore();
  const moduleRef = await Test.createTestingModule({
    imports: [
      DurableModule.forRoot({
        store: journal,
        transport: new EventEmitterTransport(new EventEmitter2()),
      }),
      AgentModule.forRoot({
        model: new FakeModelProvider(twoActions),
        store,
        actorResolver: new HeaderActorResolver(),
        durable: true,
        defaultAgent: 'default',
      }),
      AgentDurableModule,
    ],
    providers: [SaveExamTool, RecordMeasureTool, DefaultAgent, IngestWorkflow],
  }).compile();
  await moduleRef.init();
  return {
    moduleRef,
    store,
    journal,
    service: moduleRef.get(AgentService),
    engine: moduleRef.get(WorkflowEngine),
  };
}

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('condition never became true');
}

describe('a tool that starts a workflow, replayed (durable runner)', () => {
  it('two approvals in one step: both tools run once and the agent run completes', async () => {
    const { moduleRef, store, journal, service, engine } = await buildApp();
    try {
      const { runId } = await service.chat({ actor: ACTOR, message: 'keep this exam' });
      await until(
        () => store.toolCallRows().filter((row) => row.status === 'pending_approval').length === 2,
      );
      const [save, measure] = store.toolCallRows();
      await until(async () => (await engine.getRun(runId))?.status === 'suspended');

      await service.approve(ACTOR, save?.toolCallId ?? '');
      await until(() => executions.saveExam === 1);
      // The run parks again on the second approval: the next resume replays past the first tool.
      await until(async () => (await engine.getRun(runId))?.status === 'suspended');
      await service.approve(ACTOR, measure?.toolCallId ?? '');

      const result = await engine.waitForRun(runId, { timeoutMs: 5000, until: 'terminal' });
      expect(result.error?.message).toBeUndefined();
      expect(result.status).toBe('completed');
      expect(executions).toEqual({ saveExam: 1, recordMeasure: 1 });
      await engine.waitForRun('ingest-e1', { timeoutMs: 5000, until: 'terminal' });
      expect(ingested).toEqual(['e1']);
      // Nothing the tool did took a position in the agent run's journal.
      const names = (await journal.listCheckpoints(runId)).map((checkpoint) => checkpoint.name);
      expect(names.filter((name) => name.startsWith('spawn:'))).toEqual([]);
    } finally {
      await moduleRef.close();
    }
  });
});
