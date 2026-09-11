import {
  AGENT_DEPS_FACTORY,
  AgentStreamError,
  type AgentStreamEvent,
  type InputProcessor,
  type OutputProcessor,
  decodeStreamEvent,
} from '@dudousxd/nestjs-agent-core';
import {
  FakeModelProvider,
  type FakeScript,
  InMemoryAgentStore,
  InMemoryTokenStreamSink,
} from '@dudousxd/nestjs-agent-testing';
import { Injectable, type Type } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AgentDepsFactory } from './agent-deps.factory.js';
import { AgentModule } from './agent.module.js';
import { AgentService } from './agent.service.js';
import { Agent } from './decorator/agent.decorator.js';
import { HeaderActorResolver } from './resolver/header-actor-resolver.js';

const ACTOR = { id: 'u1', roles: ['ADMIN'] };
const REPORT = z.object({ answer: z.string() });

@Agent({ name: 'default', systemPrompt: 'test agent', model: 'fake-1' })
@Injectable()
class DefaultAgent {}

@Agent({
  name: 'typed',
  systemPrompt: 'typed agent',
  outputSchema: REPORT,
  outputRepairAttempts: 3,
})
@Injectable()
class TypedAgent {}

interface Options {
  inputProcessors?: InputProcessor[];
  outputProcessors?: OutputProcessor[];
}

async function buildApp(script: FakeScript, options: Options = {}, agents: Type<object>[] = []) {
  const sink = new InMemoryTokenStreamSink();
  const moduleRef = await Test.createTestingModule({
    imports: [
      AgentModule.forRoot({
        model: new FakeModelProvider(script),
        store: new InMemoryAgentStore(),
        sink,
        actorResolver: new HeaderActorResolver(),
        defaultAgent: 'default',
        ...(options.inputProcessors !== undefined
          ? { inputProcessors: options.inputProcessors }
          : {}),
        ...(options.outputProcessors !== undefined
          ? { outputProcessors: options.outputProcessors }
          : {}),
      }),
    ],
    providers: [DefaultAgent, ...agents],
  }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>();
  await app.init();
  return {
    app,
    sink,
    service: app.get(AgentService),
    factory: app.get<AgentDepsFactory>(AGENT_DEPS_FACTORY),
  };
}

/** Drain the run's stream, decoding the frames a subscriber actually received. */
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

let app: NestExpressApplication | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('AgentModule — input and output processors', () => {
  it('leaves both lists empty when the module configures none', async () => {
    const built = await buildApp(() => ({ text: 'ok' }));
    app = built.app;
    const deps = built.factory.forAgent();
    expect(deps.inputProcessors).toEqual([]);
    expect(deps.outputProcessors).toEqual([]);
  });

  it('applies module-wide processors to every agent, including one that declares nothing', async () => {
    const noop: InputProcessor = { name: 'noop', process: (prompt) => prompt };
    const gate: OutputProcessor = { name: 'gate', process: () => ({ action: 'pass' }) };
    const built = await buildApp(() => ({ text: 'ok' }), {
      inputProcessors: [noop],
      outputProcessors: [gate],
    });
    app = built.app;
    // A control one persona could opt out of is not a control — every agent gets the same chains.
    for (const name of ['default', 'typed']) {
      expect(built.factory.forAgent(name).inputProcessors).toEqual([noop]);
      expect(built.factory.forAgent(name).outputProcessors).toEqual([gate]);
    }
  });

  it('redacts the answer end-to-end, so the subscriber never sees the model’s own text', async () => {
    const redact: OutputProcessor = {
      name: 'redact',
      process: (answer) => ({
        action: 'replace',
        text: answer.text.replace('secret', '[redacted]'),
      }),
    };
    const built = await buildApp(() => ({ text: 'the secret is 42' }), {
      outputProcessors: [redact],
    });
    app = built.app;
    const { runId } = await built.service.chat({ actor: ACTOR, message: 'tell me' });
    const frames = await drain(built.sink.subscribe(runId));
    const text = frames
      .filter((frame) => frame.kind === 'text')
      .map((frame) => frame.text)
      .join('');
    expect(text).toBe('the [redacted] is 42');
    expect(JSON.stringify(frames)).not.toContain('secret');
  });

  it('fails a refused turn under its own code, not the one a model failure uses', async () => {
    const refuse: OutputProcessor = {
      name: 'guard',
      process: () => ({ action: 'reject', reason: 'leaks customer rows' }),
    };
    const built = await buildApp(() => ({ text: 'here are the rows' }), {
      outputProcessors: [refuse],
    });
    app = built.app;
    const { runId } = await built.service.chat({ actor: ACTOR, message: 'dump the table' });
    // A client that retries on `run_failed` must not retry a refusal, and nobody should be paged
    // for one.
    const failure = await drain(built.sink.subscribe(runId)).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AgentStreamError);
    expect(failure).toMatchObject({ code: 'output_rejected' });
  });
});

describe('AgentModule — @Agent({ outputSchema })', () => {
  it('resolves the declaring agent’s schema and repair bound, and no other agent’s', async () => {
    const built = await buildApp(() => ({ text: 'ok' }), {}, [TypedAgent]);
    app = built.app;
    expect(built.factory.forAgent('typed').outputSchema).toBe(REPORT);
    expect(built.factory.forAgent('typed').outputRepairAttempts).toBe(3);
    expect(built.factory.forAgent('default').outputSchema).toBeUndefined();
  });
});
