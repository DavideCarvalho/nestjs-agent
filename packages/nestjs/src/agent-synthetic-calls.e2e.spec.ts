import {
  type AgentStreamEvent,
  type ModelProvider,
  type ModelTurnArgs,
  type ModelTurnResult,
  type Passage,
  type StoredMessage,
  decodeStreamEvent,
} from '@dudousxd/nestjs-agent-core';
import { InMemoryAgentStore, InMemoryTokenStreamSink } from '@dudousxd/nestjs-agent-testing';
import { Injectable, type Type } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AgentModule } from './agent.module.js';
import { AgentService } from './agent.service.js';
import { Agent } from './decorator/agent.decorator.js';
import { HeaderActorResolver } from './resolver/header-actor-resolver.js';

/**
 * The loop delivers a retrieval and a structured answer as ordinary tool calls, and `agent-loop`'s
 * own specs pin that against `runAgentLoop` directly. Neither of those surfaces is reachable that
 * way in an app: `outputSchema` arrives from `@Agent`, through discovery, through
 * `AgentDepsFactory.forAgent`, and inject-mode retrieval from `AgentModule.forRoot({ retrieval })`.
 * A hop that dropped either would leave every loop spec passing and every app silent — so these run
 * a turn through the real module and read the thread back through the real store.
 */

const ACTOR = { id: 'u1', roles: ['ADMIN'] };
const RELEASE = z.object({ headline: z.string() });

@Agent({ name: 'default', systemPrompt: 'test agent', model: 'fake-1' })
@Injectable()
class DefaultAgent {}

@Agent({ name: 'typed', systemPrompt: 'typed agent', model: 'fake-1', outputSchema: RELEASE })
@Injectable()
class TypedAgent {}

/** Answers prose normally, and the schema when the formatting pass asks for it. */
class SchemaAwareModel implements ModelProvider {
  async runTurn(args: ModelTurnArgs): Promise<ModelTurnResult> {
    const text = args.outputSchema !== undefined ? '{"headline":"shipped"}' : 'the release is fine';
    await args.sink.write(new TextEncoder().encode(JSON.stringify({ kind: 'text', text })));
    return { text, toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
  }
}

const PASSAGES: Passage[] = [
  { id: 'runbook-01', text: 'scale the canary to zero', score: 0.9, source: 'runbook.md' },
];

interface BuildOptions {
  retrieval?: boolean;
  agents?: Type<object>[];
}

async function buildApp(options: BuildOptions = {}) {
  const sink = new InMemoryTokenStreamSink();
  const store = new InMemoryAgentStore();
  const moduleRef = await Test.createTestingModule({
    imports: [
      AgentModule.forRoot({
        model: new SchemaAwareModel(),
        store,
        sink,
        actorResolver: new HeaderActorResolver(),
        defaultAgent: 'default',
        ...(options.retrieval === true
          ? {
              retrieval: {
                mode: 'inject' as const,
                retriever: { retrieve: async (): Promise<Passage[]> => PASSAGES },
              },
            }
          : {}),
      }),
    ],
    providers: [DefaultAgent, ...(options.agents ?? [])],
  }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>();
  await app.init();
  return { app, sink, store, service: app.get(AgentService) };
}

async function drain(iterable: AsyncIterable<Uint8Array>): Promise<AgentStreamEvent[]> {
  const decoder = new TextDecoder();
  const frames: AgentStreamEvent[] = [];
  for await (const chunk of iterable) {
    for (const line of decoder.decode(chunk).split('\n')) {
      const event = line.length > 0 ? decodeStreamEvent(line) : null;
      if (event !== null) {
        frames.push(event);
      }
    }
  }
  return frames;
}

/** The client's own pairing rule: which calls on this message have an output to render. */
function settledCalls(message: StoredMessage | undefined): { name: string; output: unknown }[] {
  return (message?.toolCalls ?? []).map((call) => ({
    name: call.name,
    output: message?.toolResults?.find((result) => result.id === call.id)?.output,
  }));
}

let app: NestExpressApplication | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('AgentModule — a turn a client reads back', () => {
  it('delivers an @Agent outputSchema answer live and on reload', async () => {
    const built = await buildApp({ agents: [TypedAgent] });
    app = built.app;

    const { runId, threadId } = await built.service.chat({
      actor: ACTOR,
      message: 'summarise the release',
      agentName: 'typed',
    });
    const frames = await drain(built.sink.subscribe(runId));

    expect(
      frames.filter(
        (frame) => frame.kind === 'tool-input-available' || frame.kind === 'tool-output',
      ),
    ).toEqual([
      {
        kind: 'tool-input-available',
        id: `structured-${runId}`,
        name: 'structured_output',
        input: {},
        toolKind: 'read',
      },
      { kind: 'tool-output', id: `structured-${runId}`, output: { headline: 'shipped' } },
    ]);

    const messages = (await built.store.getThread(threadId))?.messages ?? [];
    expect(settledCalls(messages.find((message) => message.role === 'assistant'))).toEqual([
      { name: 'structured_output', output: { headline: 'shipped' } },
    ]);
  });

  it('delivers module-configured inject retrieval live and on reload', async () => {
    const built = await buildApp({ retrieval: true });
    app = built.app;

    const { runId, threadId } = await built.service.chat({
      actor: ACTOR,
      message: 'what does the runbook say?',
    });
    const frames = await drain(built.sink.subscribe(runId));

    expect(
      frames.filter(
        (frame) => frame.kind === 'tool-input-available' || frame.kind === 'tool-output',
      ),
    ).toEqual([
      {
        kind: 'tool-input-available',
        id: `retrieve-${runId}`,
        name: 'retrieve',
        input: { query: 'what does the runbook say?' },
        toolKind: 'read',
      },
      { kind: 'tool-output', id: `retrieve-${runId}`, output: { passages: PASSAGES } },
    ]);

    const messages = (await built.store.getThread(threadId))?.messages ?? [];
    expect(settledCalls(messages.find((message) => message.role === 'assistant'))).toEqual([
      { name: 'retrieve', output: { passages: PASSAGES } },
    ]);
  });
});
