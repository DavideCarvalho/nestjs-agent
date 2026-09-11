import type { AttachmentStagingStore, MessageAttachment } from '@dudousxd/nestjs-agent-core';
import { AGENT_ATTACHMENT_STAGING } from '@dudousxd/nestjs-agent-core';
import {
  FakeModelProvider,
  InMemoryAgentStore,
  InMemoryAttachmentStagingStore,
} from '@dudousxd/nestjs-agent-testing';
import { type DynamicModule, Global, Injectable, Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentModule } from '../agent.module.js';
import type { AgentModuleOptions } from '../agent.options.js';
import { Agent } from '../decorator/agent.decorator.js';
import { HeaderActorResolver } from '../resolver/header-actor-resolver.js';
import { ATTACHMENT_PAGE_SIZE, HARD_MAX_ATTACHMENT_BYTES } from './attachments.controller.js';

/**
 * `AGENT_ATTACHMENT_STAGING` is bound externally (like `AGENT_PRICING_STORE`) — a provider on the
 * root TestingModule's own `providers` is NOT visible to `AttachmentsController`, which lives inside
 * the separately-encapsulated `AgentModule`; only a `@Global()` module's exports cross that boundary.
 * This mirrors how a real host binds it (e.g. alongside a store module), not a test-only shortcut.
 */
function globalStagingModule(staging: AttachmentStagingStore): DynamicModule {
  @Global()
  @Module({
    providers: [{ provide: AGENT_ATTACHMENT_STAGING, useValue: staging }],
    exports: [AGENT_ATTACHMENT_STAGING],
  })
  class GlobalStagingModule {}
  return { module: GlobalStagingModule };
}

@Agent({ name: 'default', systemPrompt: 'test agent', model: 'fake-1' })
@Injectable()
class DefaultAgent {}

/** Records every staged file and echoes back a deterministic `MessageAttachment`. */
@Injectable()
class FakeStagingStore implements AttachmentStagingStore {
  readonly staged: { filename: string; contentType: string; sizeBytes: number; actorId: string }[] =
    [];

  async resolve(): Promise<MessageAttachment | null> {
    throw new Error('these tests only exercise the upload side');
  }

  async stage(input: Parameters<AttachmentStagingStore['stage']>[0]): Promise<MessageAttachment> {
    this.staged.push({
      filename: input.filename,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      actorId: input.actor.id,
    });
    return {
      mediaId: `media-${this.staged.length}`,
      url: `https://example.test/media-${this.staged.length}`,
      contentType: input.contentType,
      name: input.filename,
    };
  }
}

let app: NestExpressApplication | undefined;

async function boot(
  options: Partial<AgentModuleOptions> = {},
  staging?: AttachmentStagingStore,
): Promise<NestExpressApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      ...(staging !== undefined ? [globalStagingModule(staging)] : []),
      AgentModule.forRoot({
        model: new FakeModelProvider(() => ({ text: 'ok' })),
        store: new InMemoryAgentStore(),
        actorResolver: new HeaderActorResolver(),
        defaultAgent: 'default',
        attachments: { upload: true },
        ...options,
      }),
    ],
    providers: [DefaultAgent],
  }).compile();
  const testApp = moduleRef.createNestApplication<NestExpressApplication>();
  await testApp.init();
  // Only track the app for afterEach cleanup once init actually succeeds — a failed init (the
  // fails-boot-loudly test below) leaves nothing valid to close.
  app = testApp;
  return testApp;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('AttachmentsController', () => {
  it('stages an uploaded file and returns the MessageAttachment', async () => {
    const staging = new FakeStagingStore();
    const testApp = await boot({}, staging);

    const res = await request(testApp.getHttpServer())
      .post('/agent/attachments')
      .set('x-actor-id', 'u1')
      .attach('file', Buffer.from('hello world'), {
        filename: 'note.txt',
        contentType: 'text/plain',
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ contentType: 'text/plain', name: 'note.txt' });
    expect(staging.staged).toEqual([
      { filename: 'note.txt', contentType: 'text/plain', sizeBytes: 11, actorId: 'u1' },
    ]);
  });

  it('rejects a disallowed content type with 415', async () => {
    const staging = new FakeStagingStore();
    const testApp = await boot(
      { attachments: { upload: true, allowedContentTypes: ['image/png'] } },
      staging,
    );

    const res = await request(testApp.getHttpServer())
      .post('/agent/attachments')
      .set('x-actor-id', 'u1')
      .attach('file', Buffer.from('hello'), { filename: 'note.txt', contentType: 'text/plain' });

    expect(res.status).toBe(415);
    expect(staging.staged).toHaveLength(0);
  });

  it('rejects a file over the configured size cap with 413', async () => {
    const staging = new FakeStagingStore();
    const testApp = await boot({ attachments: { upload: true, maxBytes: 4 } }, staging);

    const res = await request(testApp.getHttpServer())
      .post('/agent/attachments')
      .set('x-actor-id', 'u1')
      .attach('file', Buffer.from('this is way over the limit'), {
        filename: 'note.txt',
        contentType: 'text/plain',
      });

    expect(res.status).toBe(413);
    expect(staging.staged).toHaveLength(0);
  });

  it('refuses a file over the hard ceiling, whatever the configured cap says', async () => {
    const staging = new FakeStagingStore();
    // A cap far above the ceiling: without a multer limit the whole body lands in memory first and
    // this request succeeds, which is the OOM an authenticated caller could ask for at will.
    const testApp = await boot(
      { attachments: { upload: true, maxBytes: 512 * 1024 * 1024 } },
      staging,
    );

    const res = await request(testApp.getHttpServer())
      .post('/agent/attachments')
      .set('x-actor-id', 'u1')
      .attach('file', Buffer.alloc(HARD_MAX_ATTACHMENT_BYTES + 1024), {
        filename: 'big.txt',
        contentType: 'text/plain',
      });

    expect(res.status).toBe(413);
    expect(staging.staged).toHaveLength(0);
  });

  it('rejects with 400 when the multipart "file" field is missing', async () => {
    const staging = new FakeStagingStore();
    const testApp = await boot({}, staging);

    const res = await request(testApp.getHttpServer())
      .post('/agent/attachments')
      .set('x-actor-id', 'u1')
      .field('not-file', 'nope');

    expect(res.status).toBe(400);
  });

  it('fails boot loudly when attachments.upload is true but no staging store is bound', async () => {
    await expect(boot()).rejects.toThrow(/AGENT_ATTACHMENT_STAGING/);
  });

  it('does not mount the controller at all when attachments.upload is left false', async () => {
    const testApp = await boot({ attachments: { upload: false } });
    const res = await request(testApp.getHttpServer())
      .post('/agent/attachments')
      .set('x-actor-id', 'u1')
      .attach('file', Buffer.from('hello'), { filename: 'a.txt', contentType: 'text/plain' });
    expect(res.status).toBe(404);

    const listed = await request(testApp.getHttpServer())
      .get('/agent/attachments')
      .set('x-actor-id', 'u1');
    expect(listed.status).toBe(404);
  });
});

async function stageFor(
  staging: InMemoryAttachmentStagingStore,
  actorId: string,
  filename: string,
): Promise<void> {
  await staging.stage({
    data: Buffer.from('bytes'),
    filename,
    contentType: 'image/png',
    sizeBytes: 5,
    actor: { id: actorId },
  });
}

describe('AttachmentsController — listing what an actor has staged', () => {
  it('returns the caller’s own inventory', async () => {
    const staging = new InMemoryAttachmentStagingStore();
    await stageFor(staging, 'u1', 'mine.png');
    const testApp = await boot({}, staging);

    const res = await request(testApp.getHttpServer())
      .get('/agent/attachments')
      .set('x-actor-id', 'u1');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      expect.objectContaining({ name: 'mine.png', contentType: 'image/png', sizeBytes: 5 }),
    ]);
  });

  it('never shows one actor another’s files', async () => {
    const staging = new InMemoryAttachmentStagingStore();
    await stageFor(staging, 'u1', 'mine.png');
    const testApp = await boot({}, staging);

    const res = await request(testApp.getHttpServer())
      .get('/agent/attachments')
      .set('x-actor-id', 'u2');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('carries no url — a file list must not mint one fetchable link per row', async () => {
    const staging = new InMemoryAttachmentStagingStore();
    await stageFor(staging, 'u1', 'mine.png');
    const testApp = await boot({}, staging);

    const res = await request(testApp.getHttpServer())
      .get('/agent/attachments')
      .set('x-actor-id', 'u1');

    expect(res.body[0]).not.toHaveProperty('url');
  });

  it('bounds the page rather than serving an unbounded inventory', async () => {
    const staging = new InMemoryAttachmentStagingStore();
    await stageFor(staging, 'u1', 'mine.png');
    const list = vi.spyOn(staging, 'list');
    const testApp = await boot({}, staging);

    await request(testApp.getHttpServer()).get('/agent/attachments').set('x-actor-id', 'u1');

    expect(list.mock.calls[0]?.[0]?.limit).toBe(ATTACHMENT_PAGE_SIZE);
  });

  it('answers 501 when the bound staging store keeps no inventory', async () => {
    const staging = new FakeStagingStore();
    const testApp = await boot({}, staging);

    const res = await request(testApp.getHttpServer())
      .get('/agent/attachments')
      .set('x-actor-id', 'u1');

    expect(res.status).toBe(501);
  });
});
