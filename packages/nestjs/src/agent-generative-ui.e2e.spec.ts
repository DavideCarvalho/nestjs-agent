import {
  type AgentStreamEvent,
  type AiToolCtx,
  type ModelProvider,
  type ModelTurnArgs,
  type ModelTurnResult,
  decodeStreamEvent,
} from '@dudousxd/nestjs-agent-core';
import { InMemoryAgentStore, InMemoryTokenStreamSink } from '@dudousxd/nestjs-agent-testing';
import { Injectable } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AgentModule } from './agent.module.js';
import { AgentService } from './agent.service.js';
import { Agent } from './decorator/agent.decorator.js';
import { AiTool } from './decorator/ai-tool.decorator.js';
import { HeaderActorResolver } from './resolver/header-actor-resolver.js';

/**
 * `ctx.emitUi` and `@AiTool({ terminal })` through the real module and the INLINE runner: the
 * component streams live, lands on the assistant message, and a terminal tool ends the turn
 * without another model call.
 */

const ACTOR = { id: 'u1', roles: ['ADMIN'] };

@Agent({ name: 'default', systemPrompt: 'genui test agent', model: 'fake-1' })
@Injectable()
class DefaultAgent {}

@AiTool({
  name: 'showChart',
  kind: 'read',
  description: 'show a chart',
  input: z.object({}),
  terminal: true,
})
@Injectable()
class ShowChartTool {
  async execute(_input: unknown, ctx: AiToolCtx): Promise<{ shown: string | undefined }> {
    const pushed = await ctx.emitUi?.('Chart', { points: [3, 1, 2] });
    return { shown: pushed?.id };
  }
}

class ChartingModel implements ModelProvider {
  turns = 0;
  async runTurn(args: ModelTurnArgs): Promise<ModelTurnResult> {
    this.turns += 1;
    const first = args.messages.every((message) => message.role !== 'assistant');
    return {
      text: first ? 'Here is the chart.' : 'narrating the chart',
      toolCalls: first ? [{ id: 'call-chart', name: 'showChart', input: {} }] : [],
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }
}

async function drain(iterable: AsyncIterable<Uint8Array>): Promise<AgentStreamEvent[]> {
  const decoder = new TextDecoder();
  let text = '';
  for await (const chunk of iterable) {
    text += decoder.decode(chunk, { stream: true });
  }
  return text
    .split('\n')
    .map((line) => (line.length > 0 ? decodeStreamEvent(line) : null))
    .filter((event): event is AgentStreamEvent => event !== null);
}

let app: NestExpressApplication | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('AgentModule — generative UI from a tool', () => {
  it('streams and persists what a tool pushed, and ends the turn on a terminal tool', async () => {
    const sink = new InMemoryTokenStreamSink();
    const store = new InMemoryAgentStore();
    const model = new ChartingModel();
    const moduleRef = await Test.createTestingModule({
      imports: [
        AgentModule.forRoot({
          model,
          store,
          sink,
          actorResolver: new HeaderActorResolver(),
          defaultAgent: 'default',
        }),
      ],
      providers: [DefaultAgent, ShowChartTool],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    await app.init();

    const { runId, threadId } = await app
      .get(AgentService)
      .chat({ actor: ACTOR, message: 'chart it' });
    const frames = await drain(sink.subscribe(runId));

    expect(frames.find((frame) => frame.kind === 'ui')).toEqual({
      kind: 'ui',
      id: 'call-chart:ui:0',
      component: 'Chart',
      props: { points: [3, 1, 2] },
      toolCallId: 'call-chart',
    });
    expect(model.turns).toBe(1);

    const messages = (await store.getThread(threadId))?.messages ?? [];
    const assistants = messages.filter((message) => message.role === 'assistant');
    expect(assistants).toHaveLength(1);
    expect(assistants[0]?.ui).toEqual([
      {
        id: 'call-chart:ui:0',
        component: 'Chart',
        props: { points: [3, 1, 2] },
        toolCallId: 'call-chart',
      },
    ]);
  });
});
