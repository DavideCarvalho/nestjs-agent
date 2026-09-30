import {
  type AiToolCtx,
  type ModelMessage,
  RUN_ENDED_BEFORE_TOOL_CALL,
  RUN_FAILED_MESSAGE,
  type UpdateToolCallInput,
  exposeStreamErrorDetails,
} from '@dudousxd/nestjs-agent-core';
import {
  FakeModelProvider,
  type FakeScript,
  InMemoryAgentStore,
} from '@dudousxd/nestjs-agent-testing';
import { DurableModule } from '@dudousxd/nestjs-durable';
import { InMemoryStateStore, WorkflowEngine } from '@dudousxd/nestjs-durable-core';
import { EventEmitterTransport } from '@dudousxd/nestjs-durable-transport-event-emitter';
import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AgentModule } from '../agent.module.js';
import { AgentService } from '../agent.service.js';
import { Agent } from '../decorator/agent.decorator.js';
import { AiTool } from '../decorator/ai-tool.decorator.js';
import { HeaderActorResolver } from '../resolver/header-actor-resolver.js';
import { RunNotActiveException } from '../run-not-active.exception.js';
import { AgentDurableModule } from './agent-durable.module.js';

/**
 * One dead turn must not take its thread with it.
 *
 * In production a turn asked for two approvals in one step; both were given; the run then failed on
 * the second tool's `persist:toolexec` (the runtime refused the position). What it left behind: an
 * assistant message asking for two tools and answered by none, a run row still `running`, and a
 * thread still pointed at the run. The person's next message on the same thread then failed too —
 * "No output generated. Check the stream for errors." — because the provider was handed a tool call
 * with no result after it.
 */

const ACTOR = { id: 'u1', roles: ['ADMIN'] };
const SAVE = 'call-0-saveExam';
const MEASURE = 'call-0-recordMeasure';

/** The runtime's own refusal, as the loop recognises it: by name. */
class NonDeterminismError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonDeterminismError';
  }
}

const executions: Record<string, number> = {};
const keys: Record<string, (string | undefined)[]> = {};

function ran(name: string, ctx: AiToolCtx): void {
  executions[name] = (executions[name] ?? 0) + 1;
  keys[name] = [...(keys[name] ?? []), ctx.idempotencyKey];
}

@AiTool({
  name: 'saveExam',
  kind: 'action',
  description: 'saves the exam',
  input: z.object({ examId: z.string() }),
})
@Injectable()
class SaveExamTool {
  async execute(_input: unknown, ctx: AiToolCtx) {
    ran('saveExam', ctx);
    return { done: 'saveExam' };
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
  async execute(_input: unknown, ctx: AiToolCtx) {
    ran('recordMeasure', ctx);
    return { done: 'recordMeasure' };
  }
}

@Agent({ name: 'default', systemPrompt: 'agent', model: 'fake-1' })
@Injectable()
class DefaultAgent {}

class BreakingStore extends InMemoryAgentStore {
  /** The failure `persist:toolexec:<MEASURE>` raises, while armed. */
  breakWith: Error | undefined;

  override async updateToolCall(input: UpdateToolCallInput): Promise<void> {
    if (
      this.breakWith !== undefined &&
      input.toolCallId === MEASURE &&
      input.status === 'executed'
    ) {
      throw this.breakWith;
    }
    await super.updateToolCall(input);
  }
}

async function buildApp() {
  const store = new BreakingStore();
  const prompts: ModelMessage[][] = [];
  const script: FakeScript = (args) => {
    prompts.push(args.messages);
    const asked = args.messages.filter((message) => message.role === 'user' && message.content);
    const answered = args.messages.some((message) => (message.toolCalls ?? []).length > 0);
    if (asked.length === 1 && !answered) {
      return {
        text: 'Let me keep that.',
        toolCalls: [
          { name: 'saveExam', input: { examId: 'e1' } },
          { name: 'recordMeasure', input: { value: 7 } },
        ],
      };
    }
    return { text: 'I checked: the exam was saved, the measure was not.' };
  };
  const moduleRef = await Test.createTestingModule({
    imports: [
      DurableModule.forRoot({
        store: new InMemoryStateStore(),
        transport: new EventEmitterTransport(new EventEmitter2()),
      }),
      AgentModule.forRoot({
        model: new FakeModelProvider(script),
        store,
        actorResolver: new HeaderActorResolver(),
        durable: true,
        defaultAgent: 'default',
      }),
      AgentDurableModule,
    ],
    providers: [SaveExamTool, RecordMeasureTool, DefaultAgent],
  }).compile();
  await moduleRef.init();
  return {
    moduleRef,
    store,
    prompts,
    service: moduleRef.get(AgentService),
    engine: moduleRef.get(WorkflowEngine),
  };
}

type App = Awaited<ReturnType<typeof buildApp>>;

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('condition never became true');
}

/** Read a run's stream to its end: the text it carried, and the terminal it failed with, if any. */
async function read(
  service: AgentService,
  runId: string,
): Promise<{ text: string; error?: { code: string; message: string } }> {
  const decoder = new TextDecoder();
  let text = '';
  try {
    for await (const chunk of service.subscribe(runId)) {
      text += decoder.decode(chunk, { stream: true });
    }
  } catch (error) {
    const failure = error as { code: string; message: string };
    return { text, error: { code: failure.code, message: failure.message } };
  }
  return { text };
}

async function failTheTurn(app: App, breakWith: Error) {
  const { runId, threadId } = await app.service.chat({ actor: ACTOR, message: 'keep this exam' });
  await until(
    () => app.store.toolCallRows().filter((row) => row.status === 'pending_approval').length === 2,
  );
  await until(async () => (await app.engine.getRun(runId))?.status === 'suspended');
  // Both confirmed, as in production. The first tool runs and is settled; the run parks on the
  // second approval, and dies settling what came after it.
  await app.service.approve(ACTOR, SAVE);
  await until(() => executions.saveExam === 1);
  await until(async () => (await app.engine.getRun(runId))?.status === 'suspended');
  app.store.breakWith = breakWith;
  await app.service.approve(ACTOR, MEASURE);
  await app.engine.waitForRun(runId, { timeoutMs: 5000, until: 'terminal' });
  // Left armed: the runtime may re-drive a failed run, and a run that died this way dies the same
  // way again.
  return { runId, threadId };
}

afterEach(() => {
  exposeStreamErrorDetails(undefined);
  for (const name of Object.keys(executions)) delete executions[name];
  for (const name of Object.keys(keys)) delete keys[name];
});

describe('a turn that died mid-step (durable runner)', () => {
  for (const [label, failure] of [
    [
      'the runtime refused a checkpoint position',
      new NonDeterminismError(
        'non-determinism at r#41: code expects "persist:toolexec:x" but history recorded "spawn:y"',
      ),
    ],
    ['an ordinary failure', new Error('connection reset by peer 10.0.0.7:5432')],
  ] as const) {
    it(`leaves its thread usable — ${label}`, async () => {
      exposeStreamErrorDetails(false);
      const app = await buildApp();
      try {
        const { runId, threadId } = await failTheTurn(app, failure);
        expect((await app.engine.getRun(runId))?.status).toBe('failed');

        // The person is told it failed — in words meant for a person, under a code a client can use.
        const stream = await read(app.service, runId);
        expect(stream.error).toEqual({
          code: failure.name === 'NonDeterminismError' ? 'replay_diverged' : 'run_failed',
          message: RUN_FAILED_MESSAGE,
        });

        // Nothing is left waiting on the dead run.
        expect(executions).toEqual({ saveExam: 1, recordMeasure: 1 });
        const rows = app.store.toolCallRows();
        expect(rows.filter((row) => row.status === 'pending_approval')).toEqual([]);
        expect(rows.map((row) => row.status)).toEqual(['executed', 'failed']);
        const run = app.store.governanceRuns().find((row) => row.runId === runId);
        expect(run?.status).toBe('failed');
        // The error itself stays where an operator reads it.
        expect(run?.errorMessage).toBe(failure.message);
        expect(await app.store.activeRunForThread(threadId)).toBeNull();
        // A decision for it is refused, not swallowed.
        await expect(app.service.approve(ACTOR, MEASURE)).rejects.toBeInstanceOf(
          RunNotActiveException,
        );
        await expect(app.service.approve(ACTOR, MEASURE)).rejects.toMatchObject({
          status: 409,
          response: { code: 'run_not_active' },
        });

        // "I think that failed, it probably did not record the measure?" — on the SAME thread.
        const next = await app.service.chat({ actor: ACTOR, threadId, message: 'did it fail?' });
        const answer = await read(app.service, next.runId);
        expect(answer.error).toBeUndefined();
        expect(answer.text).toContain('I checked');
        const settled = await app.engine.waitForRun(next.runId, {
          timeoutMs: 5000,
          until: 'terminal',
        });
        expect(settled.status).toBe('completed');

        // What the model was shown: every call the dead turn made is answered.
        const prompt =
          app.prompts.find((messages) =>
            messages.some((message) => message.content.startsWith('did it fail')),
          ) ?? [];
        const asking = prompt.find((message) => (message.toolCalls ?? []).length > 0);
        expect(asking?.toolCalls?.map((call) => call.id)).toEqual([SAVE, MEASURE]);
        // The tool that ran is answered with what it returned — so it is not run again — and the
        // one the run died on with what its row says.
        expect(asking?.toolResults).toEqual([
          { id: SAVE, name: 'saveExam', output: { done: 'saveExam' } },
          { id: MEASURE, name: 'recordMeasure', output: null, error: RUN_ENDED_BEFORE_TOOL_CALL },
        ]);
        // Nothing was run again behind anyone's back.
        expect(executions).toEqual({ saveExam: 1, recordMeasure: 1 });
      } finally {
        await app.moduleRef.close();
      }
    });
  }

  it('hands each tool call a key that is the same for every execution of that call', async () => {
    const app = await buildApp();
    try {
      const { runId } = await app.service.chat({ actor: ACTOR, message: 'keep this exam' });
      await until(
        () =>
          app.store.toolCallRows().filter((row) => row.status === 'pending_approval').length === 2,
      );
      await until(async () => (await app.engine.getRun(runId))?.status === 'suspended');
      await app.service.approve(ACTOR, SAVE);
      await until(() => executions.saveExam === 1);
      await until(async () => (await app.engine.getRun(runId))?.status === 'suspended');
      await app.service.approve(ACTOR, MEASURE);
      const result = await app.engine.waitForRun(runId, { timeoutMs: 5000, until: 'terminal' });
      expect(result.status).toBe('completed');
      expect(keys).toEqual({
        saveExam: [`${runId}:${SAVE}`],
        recordMeasure: [`${runId}:${MEASURE}`],
      });
    } finally {
      await app.moduleRef.close();
    }
  });
});
