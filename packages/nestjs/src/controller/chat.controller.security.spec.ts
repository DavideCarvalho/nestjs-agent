// Two attacks this surface used to allow, driven over real HTTP because both live in the request
// layer: a chat body naming the url the model provider will fetch (SSRF — the provider fetches
// whatever it is handed, link-local metadata included), and reading another actor's live turn by
// holding its runId.
import type {
  Actor,
  AttachmentStagingStore,
  MessageAttachment,
  ModelMessage,
  ModelProvider,
  ModelTurnArgs,
  ModelTurnResult,
  ResolveAttachmentInput,
  SinkWriter,
  TokenStreamSink,
} from '@dudousxd/nestjs-agent-core';
import { AGENT_ATTACHMENT_STAGING } from '@dudousxd/nestjs-agent-core';
import { FakeModelProvider, InMemoryAgentStore } from '@dudousxd/nestjs-agent-testing';
import { type DynamicModule, Global, Injectable, Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentModule } from '../agent.module.js';
import { AgentService } from '../agent.service.js';
import { Agent } from '../decorator/agent.decorator.js';
import { InProcessTokenStreamSink } from '../in-process-sink.js';
import { HeaderActorResolver } from '../resolver/header-actor-resolver.js';

const METADATA_URL = 'http://169.254.169.254/latest/meta-data/iam/security-credentials/';

@Agent({ name: 'default', systemPrompt: 'security test agent', model: 'fake-1' })
@Injectable()
class DefaultAgent {}

/** `AGENT_ATTACHMENT_STAGING` only crosses into `AgentModule` from a `@Global()` module's exports. */
function globalStagingModule(staging: AttachmentStagingStore): DynamicModule {
  @Global()
  @Module({
    providers: [{ provide: AGENT_ATTACHMENT_STAGING, useValue: staging }],
    exports: [AGENT_ATTACHMENT_STAGING],
  })
  class GlobalStagingModule {}
  return { module: GlobalStagingModule };
}

/** Owns `media-owned-by-u1` for actor `u1` and nothing else, and records every resolve attempt. */
@Injectable()
class FakeStagingStore implements AttachmentStagingStore {
  readonly resolved: ResolveAttachmentInput[] = [];

  async stage(): Promise<MessageAttachment> {
    throw new Error('not used by these tests');
  }

  async resolve(input: ResolveAttachmentInput): Promise<MessageAttachment | null> {
    this.resolved.push(input);
    if (input.mediaId !== 'media-owned-by-u1' || input.actor.id !== 'u1') {
      return null;
    }
    return {
      mediaId: 'media-owned-by-u1',
      url: 'https://media.internal.test/presigned/media-owned-by-u1',
      contentType: 'application/pdf',
      name: 'owned.pdf',
    };
  }
}

/** Blocks the turn until `release()` is called, so a run stays live while a test attacks it. */
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
    args.sink.write(new TextEncoder().encode('the answer\n'));
    return {
      text: 'the answer',
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }
}

/** Wraps the default sink to announce the first subscriber of a run, so a test can order releases. */
class ObservableSink implements TokenStreamSink {
  private readonly inner = new InProcessTokenStreamSink();
  private readonly waiters = new Map<string, () => void>();
  private readonly seen = new Set<string>();

  /** Resolves once something subscribes to `runId` (already-resolved if that happened). */
  subscribed(runId: string): Promise<void> {
    if (this.seen.has(runId)) return Promise.resolve();
    return new Promise<void>((resolve) => this.waiters.set(runId, resolve));
  }

  open(runId: string): SinkWriter | Promise<SinkWriter> {
    return this.inner.open(runId);
  }

  subscribe(runId: string): AsyncIterable<Uint8Array> {
    this.seen.add(runId);
    this.waiters.get(runId)?.();
    this.waiters.delete(runId);
    return this.inner.subscribe(runId);
  }

  close(runId: string): void {
    this.inner.close(runId);
  }
}

let app: NestExpressApplication | undefined;

interface Booted {
  app: NestExpressApplication;
  service: AgentService;
  modelCalls: ModelMessage[][];
}

async function boot(options: {
  staging?: AttachmentStagingStore;
  model?: ModelProvider;
  sink?: TokenStreamSink;
}): Promise<Booted> {
  const modelCalls: ModelMessage[][] = [];
  const moduleRef = await Test.createTestingModule({
    imports: [
      ...(options.staging !== undefined ? [globalStagingModule(options.staging)] : []),
      AgentModule.forRoot({
        model:
          options.model ??
          new FakeModelProvider((args) => {
            modelCalls.push(args.messages);
            return { text: 'ok' };
          }),
        store: new InMemoryAgentStore(),
        actorResolver: new HeaderActorResolver(),
        defaultAgent: 'default',
        ...(options.sink !== undefined ? { sink: options.sink } : {}),
      }),
    ],
    providers: [DefaultAgent],
  }).compile();
  const testApp = moduleRef.createNestApplication<NestExpressApplication>();
  await testApp.init();
  app = testApp;
  return { app: testApp, service: moduleRef.get(AgentService), modelCalls };
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

/** Every attachment url the model was handed across every turn it ran. */
function urlsSeenByModel(modelCalls: ModelMessage[][]): string[] {
  return modelCalls.flatMap((messages) =>
    messages.flatMap((message) => (message.attachments ?? []).map((a) => a.url)),
  );
}

const OWNER: Actor = { id: 'u1', roles: ['ADMIN'] };

describe('attachments a chat body claims', () => {
  it('never reaches the model when the server has no way to resolve them', async () => {
    const built = await boot({});

    const res = await request(built.app.getHttpServer())
      .post('/agent/chat')
      .set('x-actor-id', 'u1')
      .send({
        message: 'summarize this',
        attachments: [
          { mediaId: 'm1', url: METADATA_URL, contentType: 'image/png', name: 'creds.png' },
        ],
      });

    expect(res.status).toBe(501);
    expect(urlsSeenByModel(built.modelCalls)).toEqual([]);
  });

  it('is rebuilt from the staging store, discarding the url the body named', async () => {
    const staging = new FakeStagingStore();
    const built = await boot({ staging });

    const res = await request(built.app.getHttpServer())
      .post('/agent/chat')
      .set('x-actor-id', 'u1')
      .send({
        message: 'summarize this',
        attachments: [
          {
            mediaId: 'media-owned-by-u1',
            url: METADATA_URL,
            contentType: 'image/png',
            name: 'creds.png',
          },
        ],
      });

    expect(res.status).toBe(201);
    expect(urlsSeenByModel(built.modelCalls)).toEqual([
      'https://media.internal.test/presigned/media-owned-by-u1',
    ]);
    const seen = built.modelCalls.flatMap((messages) =>
      messages.flatMap((message) => message.attachments ?? []),
    );
    expect(seen[0]).toMatchObject({ contentType: 'application/pdf', name: 'owned.pdf' });
  });

  it('is refused when the mediaId belongs to another actor', async () => {
    const staging = new FakeStagingStore();
    const built = await boot({ staging });

    const res = await request(built.app.getHttpServer())
      .post('/agent/chat')
      .set('x-actor-id', 'u2')
      .send({
        message: 'summarize this',
        attachments: [{ mediaId: 'media-owned-by-u1' }],
      });

    expect(res.status).toBe(403);
    expect(staging.resolved).toEqual([
      { mediaId: 'media-owned-by-u1', actor: { id: 'u2', roles: [] } },
    ]);
    expect(built.modelCalls).toEqual([]);
  });

  it('is refused when an entry carries no mediaId at all', async () => {
    const staging = new FakeStagingStore();
    const built = await boot({ staging });

    const res = await request(built.app.getHttpServer())
      .post('/agent/chat')
      .set('x-actor-id', 'u1')
      .send({
        message: 'summarize this',
        attachments: [{ url: METADATA_URL, contentType: 'image/png', name: 'creds.png' }],
      });

    expect(res.status).toBe(400);
    expect(staging.resolved).toEqual([]);
    expect(built.modelCalls).toEqual([]);
  });

  it('is refused when the body sends something that is not a list of attachments', async () => {
    const staging = new FakeStagingStore();
    const built = await boot({ staging });

    const res = await request(built.app.getHttpServer())
      .post('/agent/chat')
      .set('x-actor-id', 'u1')
      .send({ message: 'summarize this', attachments: { mediaId: 'media-owned-by-u1' } });

    expect(res.status).toBe(400);
    expect(staging.resolved).toEqual([]);
  });

  it('is refused when a turn claims more attachments than it may carry', async () => {
    const staging = new FakeStagingStore();
    const built = await boot({ staging });

    const res = await request(built.app.getHttpServer())
      .post('/agent/chat')
      .set('x-actor-id', 'u1')
      .send({
        message: 'summarize this',
        attachments: Array.from({ length: 50 }, () => ({ mediaId: 'media-owned-by-u1' })),
      });

    expect(res.status).toBe(400);
    expect(staging.resolved).toEqual([]);
  });

  it('leaves a text-only turn untouched', async () => {
    const built = await boot({});

    const res = await request(built.app.getHttpServer())
      .post('/agent/chat')
      .set('x-actor-id', 'u1')
      .send({ message: 'no files here' });

    expect(res.status).toBe(201);
    expect(built.modelCalls).toHaveLength(1);
  });
});

describe('reading a live run by runId', () => {
  it('refuses an actor who does not own the run', async () => {
    const model = new GatedModelProvider();
    const sink = new ObservableSink();
    const built = await boot({ model, sink });
    const { runId } = await built.service.chat({ actor: OWNER, message: 'hi' });

    const attack = request(built.app.getHttpServer())
      .get(`/agent/chat/${runId}/stream`)
      .set('x-actor-id', 'u2');
    // Let the turn produce its answer the moment anything attaches — an ungated route would hand
    // the stranger the whole thing rather than leaving them on an idle connection.
    void sink.subscribed(runId).then(() => model.release());

    const res = await attack;

    expect(res.status).toBe(403);
    expect(res.text).not.toContain('the answer');
    model.release();
  });

  it('still streams the run to the actor who owns it', async () => {
    const model = new GatedModelProvider();
    const sink = new ObservableSink();
    const built = await boot({ model, sink });
    const { runId } = await built.service.chat({ actor: OWNER, message: 'hi' });

    const streaming = request(built.app.getHttpServer())
      .get(`/agent/chat/${runId}/stream`)
      .set('x-actor-id', 'u1');
    // Release only once the owner is actually attached: the run clears its thread's active stream
    // when it ends, and the ownership check reads exactly that.
    void sink.subscribed(runId).then(() => model.release());

    const res = await streaming;
    expect(res.status).toBe(200);
    expect(res.text).toContain('the answer');
  });

  it('reports a run nobody is streaming as missing rather than streaming it', async () => {
    const built = await boot({});

    const res = await request(built.app.getHttpServer())
      .get('/agent/chat/00000000-0000-0000-0000-000000000000/stream')
      .set('x-actor-id', 'u1');

    expect(res.status).toBe(404);
  });
});
