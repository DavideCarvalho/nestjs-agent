import {
  AGENT_ATTACHMENT_STAGING,
  type AttachmentStagingStore,
  type ModelMessage,
} from '@dudousxd/nestjs-agent-core';
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
import { agUiAdapter } from '../ag-ui/ag-ui.adapter.js';
import { AgentModule } from '../agent.module.js';
import { AgentService, NO_USER_MESSAGE_CODE } from '../agent.service.js';
import { Agent } from '../decorator/agent.decorator.js';
import { HeaderActorResolver } from '../resolver/header-actor-resolver.js';

/**
 * A send with nothing to answer — `POST <base>/chat` with `{}` — used to answer `201` and start a
 * run that then crashed on the missing text (`undefined.trim()`, or the provider's "text field is
 * blank"). It is a `400 no_user_message` now, on every entry point, before any thread or run exists.
 */

@Agent({ name: 'default', systemPrompt: 'test agent' })
@Injectable()
class DefaultAgent {}

function globalStagingModule(staging: AttachmentStagingStore): DynamicModule {
  @Global()
  @Module({
    providers: [{ provide: AGENT_ATTACHMENT_STAGING, useValue: staging }],
    exports: [AGENT_ATTACHMENT_STAGING],
  })
  class GlobalStagingModule {}
  return { module: GlobalStagingModule };
}

let app: NestExpressApplication | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function boot() {
  const modelCalls: ModelMessage[][] = [];
  const store = new InMemoryAgentStore();
  const staging = new InMemoryAttachmentStagingStore();
  const moduleRef = await Test.createTestingModule({
    imports: [
      globalStagingModule(staging),
      AgentModule.forRoot({
        model: new FakeModelProvider((args) => {
          modelCalls.push(args.messages);
          return { text: 'answer' };
        }),
        store,
        actorResolver: new HeaderActorResolver(),
        defaultAgent: 'default',
        followUps: false,
        adapters: [agUiAdapter()],
      }),
    ],
    providers: [DefaultAgent],
  }).compile();
  app = moduleRef.createNestApplication<NestExpressApplication>();
  await app.init();
  return {
    server: app.getHttpServer(),
    store,
    staging,
    modelCalls,
    service: app.get(AgentService),
  };
}

describe('POST /agent/chat — a body with nothing to answer', () => {
  it.each([
    ['an empty body', {}],
    ['a blank message', { message: '   ' }],
    ['an empty attachment list', { message: '', attachments: [] }],
    ['regenerate: false', { regenerate: false }],
  ])('refuses %s with 400 no_user_message and starts no run', async (_name, body) => {
    const { server, store, modelCalls } = await boot();

    const res = await request(server).post('/agent/chat').set('x-actor-id', 'u1').send(body);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ statusCode: 400, code: NO_USER_MESSAGE_CODE });
    expect(await store.listThreads('u1')).toEqual([]);
    expect(modelCalls).toEqual([]);
  });

  it('refuses a message that is not a string with 400 invalid_message', async () => {
    const { server, store } = await boot();

    const res = await request(server)
      .post('/agent/chat')
      .set('x-actor-id', 'u1')
      .send({ message: { text: 'hi' } });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'invalid_message' });
    expect(await store.listThreads('u1')).toEqual([]);
  });

  it('refuses an empty send onto an existing thread without touching it, queue included', async () => {
    const { server, store, service } = await boot();
    const first = await service.chat({ actor: { id: 'u1' }, message: 'question' });
    await vi.waitFor(async () =>
      expect((await store.getThread(first.threadId))?.messages).toHaveLength(2),
    );

    for (const mode of ['auto', 'queue', 'interrupt']) {
      const res = await request(server)
        .post('/agent/chat')
        .set('x-actor-id', 'u1')
        .send({ threadId: first.threadId, mode });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: NO_USER_MESSAGE_CODE });
    }
    expect((await store.getThread(first.threadId))?.messages.map((m) => m.content)).toEqual([
      'question',
      'answer',
    ]);
  });

  it('still runs an attachment-only send, with an empty text', async () => {
    const { server, staging, modelCalls } = await boot();
    const staged = await staging.stage({
      data: Buffer.from('%PDF-1.4'),
      filename: 'a.pdf',
      contentType: 'application/pdf',
      sizeBytes: 8,
      actor: { id: 'u1' },
    });

    const res = await request(server)
      .post('/agent/chat')
      .set('x-actor-id', 'u1')
      .send({ attachments: [{ mediaId: staged.mediaId }] });

    expect(res.status).toBe(201);
    expect(res.text).toContain('event: done');
    expect(res.text).not.toContain('event: error');
    const user = modelCalls[0]?.find((message) => message.role === 'user');
    expect(user?.attachments?.[0]).toMatchObject({ mediaId: staged.mediaId });
  });

  it('still runs a regenerate that carries no message', async () => {
    const { server, store, service } = await boot();
    const first = await service.chat({ actor: { id: 'u1' }, message: 'question' });
    await vi.waitFor(async () =>
      expect((await store.getThread(first.threadId))?.messages).toHaveLength(2),
    );

    const res = await request(server)
      .post('/agent/chat')
      .set('x-actor-id', 'u1')
      .send({ threadId: first.threadId, regenerate: true });

    expect(res.status).toBe(201);
    expect(res.text).toContain('event: done');
    expect(res.text).not.toContain('event: error');
  });

  it('runs a normal message as before', async () => {
    const { server } = await boot();
    const res = await request(server)
      .post('/agent/chat')
      .set('x-actor-id', 'u1')
      .send({ message: 'hi' });
    expect(res.status).toBe(201);
    expect(res.text).toContain('answer');
  });
});

describe('AgentService — programmatic sends with nothing to answer', () => {
  it('refuses chat() and send() before any thread exists', async () => {
    const { service, store } = await boot();
    const actor = { id: 'u1' };

    await expect(service.chat({ actor, message: undefined as never })).rejects.toMatchObject({
      response: { code: NO_USER_MESSAGE_CODE },
    });
    await expect(service.send({ actor, message: '' })).rejects.toMatchObject({
      response: { code: NO_USER_MESSAGE_CODE },
    });
    expect(await store.listThreads('u1')).toEqual([]);
  });
});

describe('POST /agent/ag-ui — a run input with nothing to answer', () => {
  const runInput = (messages: unknown[], forwardedProps: unknown = {}) => ({
    threadId: crypto.randomUUID(),
    runId: crypto.randomUUID(),
    state: {},
    messages,
    tools: [],
    context: [],
    forwardedProps,
  });

  it('refuses an empty body with 400 invalid_input', async () => {
    const { server, store } = await boot();
    const res = await request(server).post('/agent/ag-ui').set('x-actor-id', 'u1').send({});
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'invalid_input' });
    expect(await store.listThreads('u1')).toEqual([]);
  });

  it.each([
    ['no messages', []],
    ['no user message', [{ id: 'a', role: 'assistant', content: 'hello' }]],
    ['a blank user message', [{ id: 'u', role: 'user', content: '  ' }]],
  ])('refuses %s with 400 no_user_message and starts no run', async (_name, messages) => {
    const { server, store, modelCalls } = await boot();
    const res = await request(server)
      .post('/agent/ag-ui')
      .set('x-actor-id', 'u1')
      .send(runInput(messages));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: NO_USER_MESSAGE_CODE });
    expect(await store.listThreads('u1')).toEqual([]);
    expect(modelCalls).toEqual([]);
  });
});
