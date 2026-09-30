import type { ModelMessage } from '@dudousxd/nestjs-agent-core';
import { FakeModelProvider, InMemoryAgentStore } from '@dudousxd/nestjs-agent-testing';
import { MediaModule } from '@dudousxd/nestjs-media';
import {
  InMemoryDriver,
  InMemoryMediaStore,
  InMemoryUploadSessionStore,
} from '@dudousxd/nestjs-media-testing';
import { Injectable } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentModule } from '../agent.module.js';
import { Agent } from '../decorator/agent.decorator.js';
import { HeaderActorResolver } from '../resolver/header-actor-resolver.js';
import { AgentMediaAttachmentsModule } from './media-attachments.module.js';

@Agent({ name: 'default', systemPrompt: 'test agent', model: 'fake-1' })
@Injectable()
class DefaultAgent {}

let app: NestExpressApplication | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function boot() {
  const modelCalls: ModelMessage[][] = [];
  const mediaStore = new InMemoryMediaStore();
  const moduleRef = await Test.createTestingModule({
    imports: [
      MediaModule.forRoot({
        default: 'mem',
        disks: { mem: new InMemoryDriver() },
        store: mediaStore,
        uploadSessions: new InMemoryUploadSessionStore(),
        tus: { disk: 'mem' },
      }),
      AgentModule.forRoot({
        model: new FakeModelProvider((args) => {
          modelCalls.push(args.messages);
          return { text: 'ok' };
        }),
        store: new InMemoryAgentStore(),
        actorResolver: new HeaderActorResolver(),
        defaultAgent: 'default',
      }),
      AgentMediaAttachmentsModule.forRoot(),
    ],
    providers: [DefaultAgent],
  }).compile();
  const testApp = moduleRef.createNestApplication<NestExpressApplication>();
  // nestjs-media's documented requirement: tus PATCH bodies arrive as raw Buffers.
  testApp.useBodyParser('raw', { type: 'application/offset+octet-stream' });
  await testApp.init();
  app = testApp;
  return { app: testApp, modelCalls, mediaStore };
}

const BYTES = Buffer.from('%PDF-1.4 tiny');

/** The whole client flow: open the session on the agent, stream to media's tus, complete. */
async function uploadThroughTus(server: ReturnType<NestExpressApplication['getHttpServer']>) {
  const begun = await request(server)
    .post('/agent/attachments/uploads')
    .set('x-actor-id', 'alice')
    .send({ filename: 'report.pdf', contentType: 'application/pdf', size: BYTES.byteLength });
  expect(begun.status).toBe(201);
  const { mediaId, location } = begun.body as { mediaId: string; location: string };

  const patched = await request(server)
    .patch(location)
    .set('Tus-Resumable', '1.0.0')
    .set('Upload-Offset', '0')
    .set('Content-Type', 'application/offset+octet-stream')
    .send(BYTES);
  expect(patched.status).toBe(204);
  expect(patched.headers['upload-offset']).toBe(String(BYTES.byteLength));
  return mediaId;
}

describe('AgentMediaAttachmentsModule (e2e)', () => {
  it('streams through media’s tus endpoint, completes, and the turn sees the file', async () => {
    const built = await boot();
    const server = built.app.getHttpServer();
    const mediaId = await uploadThroughTus(server);

    const completed = await request(server)
      .post(`/agent/attachments/uploads/${mediaId}/complete`)
      .set('x-actor-id', 'alice');
    expect(completed.status).toBe(200);
    expect(completed.body).toMatchObject({
      mediaId,
      contentType: 'application/pdf',
      name: 'report.pdf',
    });

    const chat = await request(server)
      .post('/agent/chat')
      .set('x-actor-id', 'alice')
      .send({ message: 'summarize', attachments: [{ mediaId }] });
    expect(chat.status).toBe(201);
    await vi.waitFor(() => expect(built.modelCalls.length).toBeGreaterThan(0));
    const seen = built.modelCalls.flatMap((messages) =>
      messages.flatMap((message) => message.attachments ?? []),
    );
    expect(seen[0]).toMatchObject({
      mediaId,
      contentType: 'application/pdf',
      url: `data:application/pdf;base64,${BYTES.toString('base64')}`,
    });
  });

  it('refuses another actor on complete, discard and in a chat turn', async () => {
    const built = await boot();
    const server = built.app.getHttpServer();
    const mediaId = await uploadThroughTus(server);

    const complete = await request(server)
      .post(`/agent/attachments/uploads/${mediaId}/complete`)
      .set('x-actor-id', 'mallory');
    expect(complete.status).toBe(404);
    const discard = await request(server)
      .delete(`/agent/attachments/uploads/${mediaId}`)
      .set('x-actor-id', 'mallory');
    expect(discard.status).toBe(404);
    const chat = await request(server)
      .post('/agent/chat')
      .set('x-actor-id', 'mallory')
      .send({ message: 'summarize', attachments: [{ mediaId }] });
    expect(chat.status).toBe(403);
  });

  it('validates the declared file before a session opens', async () => {
    const built = await boot();
    const res = await request(built.app.getHttpServer())
      .post('/agent/attachments/uploads')
      .set('x-actor-id', 'alice')
      .send({ filename: 'x.exe', contentType: 'application/x-msdownload', size: 3 });
    expect(res.status).toBe(415);
  });

  it('lets the owner discard an upload', async () => {
    const built = await boot();
    const server = built.app.getHttpServer();
    const mediaId = await uploadThroughTus(server);
    const res = await request(server)
      .delete(`/agent/attachments/uploads/${mediaId}`)
      .set('x-actor-id', 'alice');
    expect(res.status).toBe(204);
    expect(await built.mediaStore.find(mediaId)).toBeNull();
  });

  it('backs the plain POST /agent/attachments route and its listing too', async () => {
    const built = await boot();
    const server = built.app.getHttpServer();
    const posted = await request(server)
      .post('/agent/attachments')
      .set('x-actor-id', 'alice')
      .attach('file', Buffer.from('hello'), { filename: 'note.txt', contentType: 'text/plain' });
    expect(posted.status).toBe(201);
    const listed = await request(server).get('/agent/attachments').set('x-actor-id', 'alice');
    expect(listed.body).toEqual([
      expect.objectContaining({ mediaId: posted.body.mediaId, name: 'note.txt' }),
    ]);
  });
});

describe('AgentMediaAttachmentsModule defaults', () => {
  it('is the single source of limits, served by GET /agent/config with the resumable mode', async () => {
    const built = await boot();
    const res = await request(built.app.getHttpServer())
      .get('/agent/config')
      .set('x-actor-id', 'alice');
    expect(res.body.attachments).toMatchObject({
      enabled: true,
      upload: 'resumable',
      maxBytes: 20 * 1024 * 1024,
    });
  });

  it('boots with forRoot() and no options at all', async () => {
    const built = await boot();
    const res = await request(built.app.getHttpServer())
      .post('/agent/attachments/uploads')
      .set('x-actor-id', 'alice')
      .send({ filename: 'a.png', contentType: 'image/png', size: 3 });
    expect(res.status).toBe(201);
  });
});
