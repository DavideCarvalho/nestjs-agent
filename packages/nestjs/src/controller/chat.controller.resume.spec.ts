// The chat stream numbers its frames so a client that dropped can resume where it left off instead
// of replaying the whole run into a message it already rendered.
import type {
  ModelProvider,
  ModelTurnArgs,
  ModelTurnResult,
  SinkWriter,
  TokenStreamSink,
} from '@dudousxd/nestjs-agent-core';
import { FakeModelProvider, InMemoryAgentStore } from '@dudousxd/nestjs-agent-testing';
import { Injectable } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentModule } from '../agent.module.js';
import { AgentService } from '../agent.service.js';
import { Agent } from '../decorator/agent.decorator.js';
import { InProcessTokenStreamSink } from '../in-process-sink.js';
import { HeaderActorResolver } from '../resolver/header-actor-resolver.js';

@Agent({ name: 'default', systemPrompt: 'resume test agent', model: 'fake-1' })
@Injectable()
class DefaultAgent {}

/** Holds the turn until released, then writes a few frames, so several readers can attach first. */
class GatedModelProvider implements ModelProvider {
  private open!: () => void;
  private readonly gate = new Promise<void>((resolve) => {
    this.open = resolve;
  });

  release(): void {
    this.open();
  }

  async runTurn(args: ModelTurnArgs): Promise<ModelTurnResult> {
    await this.gate;
    const encoder = new TextEncoder();
    for (const text of ['one ', 'two ', 'three']) {
      await args.sink.write(encoder.encode(`${JSON.stringify({ kind: 'text', text })}\n`));
    }
    return { text: 'one two three', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
  }
}

/** Resolves once `count` readers have attached to a run. */
class CountingSink implements TokenStreamSink {
  private readonly inner = new InProcessTokenStreamSink();
  private attached = 0;
  private readonly waiters: Array<{ count: number; resolve: () => void }> = [];

  attachedAtLeast(count: number): Promise<void> {
    if (this.attached >= count) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push({ count, resolve }));
  }

  open(runId: string): SinkWriter | Promise<SinkWriter> {
    return this.inner.open(runId);
  }

  subscribe(runId: string): AsyncIterable<Uint8Array> {
    this.attached += 1;
    for (const waiter of this.waiters.filter((w) => w.count <= this.attached)) waiter.resolve();
    return this.inner.subscribe(runId);
  }

  close(runId: string): void {
    this.inner.close(runId);
  }
}

let app: NestExpressApplication | undefined;

async function boot(model: ModelProvider, sink?: TokenStreamSink) {
  const moduleRef = await Test.createTestingModule({
    imports: [
      AgentModule.forRoot({
        model,
        store: new InMemoryAgentStore(),
        actorResolver: new HeaderActorResolver(),
        defaultAgent: 'default',
        ...(sink !== undefined ? { sink } : {}),
      }),
    ],
    providers: [DefaultAgent],
  }).compile();
  const testApp = moduleRef.createNestApplication<NestExpressApplication>();
  await testApp.init();
  app = testApp;
  return { app: testApp, service: moduleRef.get(AgentService) };
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

interface Frame {
  id?: string;
  event?: string;
  data?: string;
}

function framesOf(text: string): Frame[] {
  return text
    .split('\n\n')
    .filter((block) => block.trim().length > 0)
    .map((block) => {
      const frame: Frame = {};
      for (const line of block.split('\n')) {
        if (line.startsWith('id: ')) frame.id = line.slice(4);
        else if (line.startsWith('event: ')) frame.event = line.slice(7);
        else if (line.startsWith('data: ')) frame.data = line.slice(6);
      }
      return frame;
    });
}

describe('chat stream sequence numbers', () => {
  it('numbers every event frame from 1, and leaves meta and done unnumbered', async () => {
    const built = await boot(new FakeModelProvider(() => ({ text: 'hello' })));

    const res = await request(built.app.getHttpServer())
      .post('/agent/chat')
      .set('x-actor-id', 'u1')
      .send({ message: 'hi' });

    const frames = framesOf(res.text);
    expect(frames[0]).toMatchObject({ event: 'meta' });
    expect(frames[0]?.id).toBeUndefined();
    expect(frames.at(-1)).toMatchObject({ event: 'done' });
    expect(frames.at(-1)?.id).toBeUndefined();
    const events = frames.filter((frame) => frame.event === undefined);
    expect(events.length).toBeGreaterThan(0);
    expect(events.map((frame) => frame.id)).toEqual(events.map((_, index) => String(index + 1)));
  });

  it('resumes after a cursor from ?after= or Last-Event-ID, with the same numbers', async () => {
    const model = new GatedModelProvider();
    const sink = new CountingSink();
    const built = await boot(model, sink);
    const { runId } = await built.service.chat({ actor: { id: 'u1' }, message: 'hi' });
    const server = built.app.getHttpServer();

    const full = request(server).get(`/agent/chat/${runId}/stream`).set('x-actor-id', 'u1');
    const afterTwo = request(server)
      .get(`/agent/chat/${runId}/stream?after=2`)
      .set('x-actor-id', 'u1');
    const lastEventId = request(server)
      .get(`/agent/chat/${runId}/stream`)
      .set('x-actor-id', 'u1')
      .set('last-event-id', '3');
    // Supertest only sends on `then`, so start all three before the turn is let go.
    const responses = Promise.all([full, afterTwo, lastEventId]);
    await sink.attachedAtLeast(3);
    model.release();
    const [fullRes, afterTwoRes, lastEventIdRes] = await responses;

    const all = framesOf(fullRes.text).filter((frame) => frame.id !== undefined);
    expect(all.length).toBeGreaterThan(3);
    expect(framesOf(afterTwoRes.text)[0]).toMatchObject({ event: 'meta' });
    expect(framesOf(afterTwoRes.text).filter((frame) => frame.id !== undefined)).toEqual(
      all.filter((frame) => Number(frame.id) > 2),
    );
    expect(framesOf(lastEventIdRes.text).filter((frame) => frame.id !== undefined)).toEqual(
      all.filter((frame) => Number(frame.id) > 3),
    );
    expect(framesOf(afterTwoRes.text).at(-1)).toMatchObject({ event: 'done' });
  });
});
