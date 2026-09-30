import {
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
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AgentModule } from '../agent.module.js';
import { AgentService } from '../agent.service.js';
import { Agent } from '../decorator/agent.decorator.js';
import { AiTool } from '../decorator/ai-tool.decorator.js';
import { HeaderActorResolver } from '../resolver/header-actor-resolver.js';
import { RunNotActiveException } from '../run-not-active.exception.js';

/**
 * The inline runner's half of "one dead turn must not take its thread with it": a turn that fails
 * while settling its first tool still has a second call showing an approval card. Nothing is
 * running that could ever read a decision on it.
 */

const ACTOR = { id: 'u1', roles: ['ADMIN'] };
const SAVE = 'call-0-saveExam';
const MEASURE = 'call-0-recordMeasure';

@AiTool({ name: 'saveExam', kind: 'action', description: 'saves', input: z.object({}) })
@Injectable()
class SaveExamTool {
  async execute() {
    return { done: 'saveExam' };
  }
}

@AiTool({ name: 'recordMeasure', kind: 'action', description: 'records', input: z.object({}) })
@Injectable()
class RecordMeasureTool {
  async execute() {
    return { done: 'recordMeasure' };
  }
}

@Agent({ name: 'default', systemPrompt: 'agent', model: 'fake-1' })
@Injectable()
class DefaultAgent {}

class BreakingStore extends InMemoryAgentStore {
  override async updateToolCall(input: UpdateToolCallInput): Promise<void> {
    if (input.toolCallId === SAVE && input.status === 'executed') {
      throw new Error('connection reset by peer 10.0.0.7:5432');
    }
    await super.updateToolCall(input);
  }
}

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition never became true');
}

afterEach(() => exposeStreamErrorDetails(undefined));

describe('a turn that died mid-step (inline runner)', () => {
  it('fails the calls it left waiting, refuses a late decision, and the thread still answers', async () => {
    exposeStreamErrorDetails(false);
    const store = new BreakingStore();
    const prompts: ModelMessage[][] = [];
    const script: FakeScript = (args) => {
      prompts.push(args.messages);
      const asked = args.messages.filter((message) => message.role === 'user' && message.content);
      const answered = args.messages.some((message) => (message.toolCalls ?? []).length > 0);
      return asked.length === 1 && !answered
        ? {
            text: 'saving',
            toolCalls: [
              { name: 'saveExam', input: {} },
              { name: 'recordMeasure', input: {} },
            ],
          }
        : { text: 'I checked.' };
    };
    const moduleRef = await Test.createTestingModule({
      imports: [
        AgentModule.forRoot({
          model: new FakeModelProvider(script),
          store,
          actorResolver: new HeaderActorResolver(),
          defaultAgent: 'default',
        }),
      ],
      providers: [SaveExamTool, RecordMeasureTool, DefaultAgent],
    }).compile();
    await moduleRef.init();
    const service = moduleRef.get(AgentService);
    try {
      const { runId, threadId } = await service.chat({ actor: ACTOR, message: 'keep this exam' });
      await until(
        () => store.toolCallRows().filter((row) => row.status === 'pending_approval').length === 2,
      );
      const failed = (async () => {
        try {
          for await (const _chunk of service.subscribe(runId)) {
            /* drained */
          }
          return undefined;
        } catch (error) {
          return error as { code: string; message: string };
        }
      })();
      await service.approve(ACTOR, SAVE);
      const failure = await failed;
      expect({ code: failure?.code, message: failure?.message }).toEqual({
        code: 'run_failed',
        message: RUN_FAILED_MESSAGE,
      });

      await until(async () => (await store.activeRunForThread(threadId)) === null);
      // Neither call's row was settled by the run: the first died being written, the second was
      // never decided. Both say so, rather than showing a card nothing will answer.
      expect(store.toolCallRows().map((row) => [row.toolCallId, row.status, row.error])).toEqual([
        [SAVE, 'failed', RUN_ENDED_BEFORE_TOOL_CALL],
        [MEASURE, 'failed', RUN_ENDED_BEFORE_TOOL_CALL],
      ]);
      await expect(service.approve(ACTOR, MEASURE)).rejects.toBeInstanceOf(RunNotActiveException);

      const next = await service.chat({ actor: ACTOR, threadId, message: 'did it fail?' });
      for await (const _chunk of service.subscribe(next.runId)) {
        /* drained */
      }
      const prompt =
        prompts.find((messages) => messages.some((m) => m.content.startsWith('did it fail'))) ?? [];
      const asking = prompt.find((message) => (message.toolCalls ?? []).length > 0);
      expect(asking?.toolResults?.map((result) => [result.id, result.error])).toEqual([
        [SAVE, RUN_ENDED_BEFORE_TOOL_CALL],
        [MEASURE, RUN_ENDED_BEFORE_TOOL_CALL],
      ]);
    } finally {
      await moduleRef.close();
    }
  });
});
