import {
  type AgentStreamEvent,
  type ModelProvider,
  type ModelTurnArgs,
  type ModelTurnResult,
  type OutputProcessor,
  decodeStreamEvent,
  encodeStreamEvent,
} from '@dudousxd/nestjs-agent-core';
import { InMemoryAgentStore, InMemoryTokenStreamSink } from '@dudousxd/nestjs-agent-testing';
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

@Agent({ name: 'default', systemPrompt: 'gated dispatch agent', model: 'fake-1' })
@Injectable()
class DefaultAgent {}

/**
 * Writes bare bytes into the sink, which is what a provider outside the `AgentStreamEvent`
 * vocabulary does — and the shape that makes an ungated stream unmistakable in the assertion below.
 */
class LeakyModel implements ModelProvider {
  async runTurn(args: ModelTurnArgs): Promise<ModelTurnResult> {
    const text = 'the secret is 42';
    await args.sink.write(new TextEncoder().encode(text));
    return { text, toolCalls: [], usage: { inputTokens: args.messages.length, outputTokens: 4 } };
  }
}

/** Streams the answer two characters at a time, in the vocabulary an incremental gate releases in. */
class ChunkedModel implements ModelProvider {
  async runTurn(args: ModelTurnArgs): Promise<ModelTurnResult> {
    const text = 'the secret is 42';
    for (let at = 0; at < text.length; at += 2) {
      await args.sink.write(encodeStreamEvent({ kind: 'text', text: text.slice(at, at + 2) }));
    }
    return { text, toolCalls: [], usage: { inputTokens: args.messages.length, outputTokens: 4 } };
  }
}

const redact: OutputProcessor = {
  name: 'redact',
  process: (answer) => ({ action: 'replace', text: answer.text.replace('secret', '[redacted]') }),
};

const incrementalRedact: OutputProcessor = {
  ...redact,
  incremental: { lookbackChars: 6 },
};

async function buildApp(options: { model: ModelProvider; outputProcessors: OutputProcessor[] }) {
  const stateStore = new InMemoryStateStore();
  const sink = new InMemoryTokenStreamSink();
  const moduleRef = await Test.createTestingModule({
    imports: [
      DurableModule.forRoot({
        store: stateStore,
        transport: new EventEmitterTransport(new EventEmitter2()),
      }),
      AgentModule.forRoot({
        model: options.model,
        store: new InMemoryAgentStore(),
        sink,
        durable: true,
        defaultAgent: 'default',
        dispatchedSteps: true,
        outputProcessors: options.outputProcessors,
      }),
      AgentDurableModule,
    ],
    providers: [DefaultAgent],
  }).compile();
  await moduleRef.init();
  return { moduleRef, stateStore, sink };
}

async function drain(iterable: AsyncIterable<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let out = '';
  for await (const chunk of iterable) {
    out += decoder.decode(chunk);
  }
  return out;
}

describe('output gating with dispatched model steps', () => {
  it('holds the answer on the worker that ran the model, so the gate is not bypassed', async () => {
    const { moduleRef, stateStore, sink } = await buildApp({
      model: new LeakyModel(),
      outputProcessors: [redact],
    });
    try {
      const { runId } = await moduleRef
        .get(AgentService)
        .chat({ actor: ACTOR, message: 'tell me' });
      const engine = moduleRef.get(WorkflowEngine);
      const result = await engine.waitForRun(runId, { timeoutMs: 5000, until: 'terminal' });
      expect(result.status).toBe('completed');

      const journal = (await stateStore.listCheckpoints(runId))
        .sort((left, right) => left.seq - right.seq)
        .map((checkpoint) => checkpoint.name);
      // The model call genuinely left this pod (no in-process `llm:0`), which is the posture the
      // gate has to survive: the sink the model wrote to is on the far side of the dispatch.
      expect(journal).not.toContain('llm:0');
      expect(journal).toContain('process:output:0');

      const streamed = await drain(sink.subscribe(runId));
      expect(streamed).toContain('the [redacted] is 42');
      expect(streamed).not.toContain('the secret is 42');
    } finally {
      await moduleRef.close();
    }
  });

  it('holds an INCREMENTAL chain whole too, because the loop cannot interpose on a worker\u2019s sink', async () => {
    const { moduleRef, stateStore, sink } = await buildApp({
      model: new ChunkedModel(),
      outputProcessors: [incrementalRedact],
    });
    try {
      const { runId } = await moduleRef
        .get(AgentService)
        .chat({ actor: ACTOR, message: 'tell me' });
      const engine = moduleRef.get(WorkflowEngine);
      const result = await engine.waitForRun(runId, { timeoutMs: 5000, until: 'terminal' });
      expect(result.status).toBe('completed');

      const journal = (await stateStore.listCheckpoints(runId))
        .sort((left, right) => left.seq - right.seq)
        .map((checkpoint) => checkpoint.name);
      expect(journal).not.toContain('llm:0');
      expect(journal).toContain('process:output:0');

      const text = (await drain(sink.subscribe(runId)))
        .split('\n')
        .filter((line) => line.length > 0)
        .map(decodeStreamEvent)
        .filter((event): event is AgentStreamEvent => event !== null)
        .filter((event) => event.kind === 'text')
        .map((event) => event.text);
      // The declaration buys nothing here: there is no prefix to release, because the model wrote
      // its chunks into a sink on the far side of the dispatch. One frame, once the gate passed.
      expect(text).toEqual(['the [redacted] is 42']);
    } finally {
      await moduleRef.close();
    }
  });
});
