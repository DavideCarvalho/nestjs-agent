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
import { afterEach, describe, expect, it, vi } from 'vitest';
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
    const testApp = await boot({ attachments: { allowedContentTypes: ['image/png'] } }, staging);

    const res = await request(testApp.getHttpServer())
      .post('/agent/attachments')
      .set('x-actor-id', 'u1')
      .attach('file', Buffer.from('hello'), { filename: 'note.txt', contentType: 'text/plain' });

    expect(res.status).toBe(415);
    expect(staging.staged).toHaveLength(0);
  });

  it('rejects a file over the configured size cap with 413', async () => {
    const staging = new FakeStagingStore();
    const testApp = await boot({ attachments: { maxBytes: 4 } }, staging);

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
    const testApp = await boot({ attachments: { maxBytes: 512 * 1024 * 1024 } }, staging);

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

  it('answers 501 with no staging store bound — the route exists, uploads are just off', async () => {
    const testApp = await boot();
    const res = await request(testApp.getHttpServer())
      .post('/agent/attachments')
      .set('x-actor-id', 'u1')
      .attach('file', Buffer.from('hello'), { filename: 'a.txt', contentType: 'text/plain' });
    expect(res.status).toBe(501);
  });

  it('takes the staging store’s own declared limits over the module option', async () => {
    const staging = new FakeStagingStore();
    Object.assign(staging, {
      describe: () => ({ maxBytes: 3, allowedContentTypes: ['text/plain'], upload: 'multipart' }),
    });
    const testApp = await boot({ attachments: { maxBytes: 1_000_000 } }, staging);
    const res = await request(testApp.getHttpServer())
      .post('/agent/attachments')
      .set('x-actor-id', 'u1')
      .attach('file', Buffer.from('hello'), { filename: 'a.txt', contentType: 'text/plain' });
    expect(res.status).toBe(413);

    const config = await request(testApp.getHttpServer())
      .get('/agent/config')
      .set('x-actor-id', 'u1');
    expect(config.body.attachments).toEqual({
      enabled: true,
      upload: 'multipart',
      maxBytes: 3,
      allowedContentTypes: ['text/plain'],
      maxPerMessage: 10,
    });
  });
});
