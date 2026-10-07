import { AgentModule } from '@dudousxd/nestjs-agent';
import {
  AGENT_CHANNEL_STORE,
  type ActionProposal,
  type ElicitationRequest,
  InMemoryAgentStore,
  InMemoryChannelStore,
} from '@dudousxd/nestjs-agent-core';
import { FakeModelProvider } from '@dudousxd/nestjs-agent-testing';
import {
  Global,
  Module,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { AgentChannelsModule } from './agent-channels.module.js';
import { AgentChannelsService } from './agent-channels.service.js';
import {
  actor,
  channel,
  fakeAdapter,
  fakeService,
  inbound,
  request,
  texts,
  until,
} from './channels.spec-helper.js';
import { ChannelMediaTooLargeError } from './http.js';
import type { ChannelMediaFile, InboundMedia } from './types.js';

// ── questions ─────────────────────────────────────────────────────────────────

describe('questions on a text channel', () => {
  const ask: ElicitationRequest = {
    id: 'ask-1',
    source: 'ask',
    preamble: 'Two quick questions.',
    questions: [
      {
        id: 'size',
        prompt: 'Which size?',
        options: [
          { value: 's', label: 'Small' },
          { value: 'l', label: 'Large' },
        ],
      },
      { id: 'note', prompt: 'Anything else?', input: { type: 'text' }, defaults: [] },
    ],
  };

  /** A run that asks, waits for the answer, then answers. */
  function askingService() {
    let answered!: () => void;
    const answer = new Promise<void>((resolve) => {
      answered = resolve;
    });
    const service = fakeService(
      async function* () {
        yield { kind: 'text', text: 'Let me check.' };
        yield { kind: 'elicitation', id: 'ask-1', request: ask };
        await answer;
        yield { kind: 'text', text: 'Ordered a large one.' };
      },
      {
        answer: async (...args: unknown[]) => {
          service.answered.push(args);
          answered();
        },
      },
    );
    return service;
  }

  it('asks one question at a time as text and resumes the run with the answers', async () => {
    const { adapter, outbox } = fakeAdapter();
    const service = askingService();
    const handler = channel(adapter, service);

    await handler.handle(request(inbound('order a shirt')));
    await until(() => outbox.length === 2);
    expect(texts(outbox)).toEqual([
      'Let me check.',
      [
        'Two quick questions.',
        '',
        '*(1/2) Which size?*',
        '',
        '1. Small',
        '2. Large',
        '',
        'Reply with the number of your choice.',
      ].join('\n'),
    ]);

    // not an option: asked again
    await handler.handle(request(inbound('medium')));
    await until(() => outbox.length === 4);
    expect(texts(outbox)[2]).toBe('I could not read that answer (not one of the options).');
    expect(texts(outbox)[3]).toContain('Which size?');

    await handler.handle(request(inbound('2')));
    await until(() => outbox.length === 5);
    expect(texts(outbox)[4]).toBe('*(2/2) Anything else?*');

    await handler.handle(request(inbound('Blue please')));
    await handler.drain();
    expect(service.answered).toEqual([
      [actor, 'ask-1', { size: ['l'], note: ['Blue please'] }, { via: 'test' }],
    ]);
    expect(texts(outbox).at(-1)).toBe('Ordered a large one.');
    // The answers were answers, not new turns.
    expect(service.sends).toHaveLength(1);
  });

  it('leaves a skipped question to its defaults', async () => {
    const { adapter, outbox } = fakeAdapter();
    const service = askingService();
    const handler = channel(adapter, service);
    await handler.handle(request(inbound('order')));
    await until(() => outbox.length === 2);
    await handler.handle(request(inbound('1')));
    await until(() => outbox.length === 3);
    await handler.handle(request(inbound('skip')));
    await handler.drain();
    expect(service.answered[0][2]).toEqual({ size: ['s'] });
  });

  it('proceeds without the answers once nobody replied for questionTimeoutMs', async () => {
    const { adapter, outbox } = fakeAdapter();
    let resumed!: () => void;
    const resume = new Promise<void>((resolve) => {
      resumed = resolve;
    });
    const service = fakeService(
      async function* () {
        yield { kind: 'elicitation', id: 'ask-1', request: ask };
        await resume;
        yield { kind: 'text', text: 'Went with defaults.' };
      },
      { answer: async () => {} },
    );
    service.skip = async (who, toolCallId, opts) => {
      service.skipped.push({ actor: who, toolCallId, ...opts });
      resumed();
    };
    const handler = channel(adapter, service, { questionTimeoutMs: 50 });
    await handler.handle(request(inbound('order')));
    await handler.drain();
    expect(service.skipped).toEqual([{ actor, toolCallId: 'ask-1', via: 'test' }]);
    expect(texts(outbox).at(-1)).toBe('Went with defaults.');
    // and the next message is a message again, not an answer
    await handler.handle(request(inbound('thanks')));
    await handler.drain();
    expect(service.sends.map((send) => send.message)).toEqual(['order', 'thanks']);
  });
});

describe('questions against the real agent (inline runner, ask tool)', () => {
  it('asks the ask tool’s question as text and resumes the run with the chosen option', async () => {
    const scope = {
      id: 'scope',
      prompt: 'How wide should I go?',
      options: [
        { value: 'narrow', label: 'This module only' },
        { value: 'everything', label: 'The whole repo' },
      ],
      defaults: ['narrow'],
    };
    const { adapter, outbox } = fakeAdapter();
    let threadId: string | null = null;
    const module = await Test.createTestingModule({
      imports: [
        AgentModule.forRoot({
          store: new InMemoryAgentStore(),
          ask: true,
          actorResolver: { resolve: () => actor },
          model: new FakeModelProvider((args, turn) =>
            turn === 0
              ? {
                  text: 'One question first.',
                  toolCall: { name: 'ask', input: { questions: [scope] } },
                }
              : { text: `Going with ${JSON.stringify(args.messages.at(-1) ?? null)}` },
          ),
        }),
        AgentChannelsModule.forRoot({
          path: false,
          channels: [
            {
              adapter,
              actor: () => actor,
              thread: () => threadId,
              onThreadCreated: (id) => {
                threadId = id;
              },
            },
          ],
        }),
      ],
    }).compile();
    const app = module.createNestApplication();
    await app.init();
    try {
      const channels = app.get(AgentChannelsService);
      await channels.handleRequest('test', request(inbound('tidy up')));
      await until(() => outbox.length === 2).catch((error) => {
        throw new Error(`${error}: ${JSON.stringify(texts(outbox))}`);
      });
      expect(texts(outbox)[1]).toContain('1. This module only\n2. The whole repo');
      await channels.handleRequest('test', request(inbound('2')));
      await channels.drain();
      expect(texts(outbox).at(-1)).toContain('everything');
    } finally {
      await app.close();
    }
  });
});

// ── media ─────────────────────────────────────────────────────────────────────

describe('media on a text channel', () => {
  const limits = {
    enabled: true,
    upload: 'multipart' as const,
    maxBytes: 1000,
    allowedContentTypes: ['image/jpeg', 'application/pdf'],
    maxPerMessage: 10,
  };

  function mediaSetup(opts: { attachments?: boolean } = {}) {
    const { adapter, outbox } = fakeAdapter();
    const downloads: InboundMedia[] = [];
    adapter.download = async (media, { maxBytes }): Promise<ChannelMediaFile> => {
      downloads.push(media);
      const { size, type } = media.ref as { size: number; type?: string };
      if (size > maxBytes) throw new ChannelMediaTooLargeError(maxBytes);
      return { data: Buffer.alloc(size), contentType: type ?? media.contentType ?? 'image/jpeg' };
    };
    const staged: unknown[] = [];
    const service = fakeService([{ kind: 'text', text: 'Nice picture.' }], {
      attachmentLimits: () => (opts.attachments === false ? { ...limits, enabled: false } : limits),
      stageAttachment: async (
        who: unknown,
        file: { data: Buffer; contentType: string; filename: string },
      ) => {
        if (!limits.allowedContentTypes.includes(file.contentType))
          throw new UnsupportedMediaTypeException('no');
        if (file.data.byteLength > limits.maxBytes) throw new PayloadTooLargeException('no');
        staged.push({ who, ...file, size: file.data.byteLength });
        return {
          mediaId: `media-${staged.length}`,
          url: 'https://x',
          contentType: file.contentType,
          name: file.filename,
        };
      },
    });
    const handler = channel(adapter, service);
    return { adapter, outbox, downloads, staged, service, handler };
  }

  const photo = (size: number, extra: Partial<InboundMedia> = {}): InboundMedia => ({
    kind: 'image',
    contentType: 'image/jpeg',
    ref: { size },
    ...extra,
  });

  it('downloads, stages and attaches an image, with its caption as the message', async () => {
    const { handler, staged, service, outbox } = mediaSetup();
    await handler.handle(request(inbound('what is this?', { media: [photo(10)] })));
    await handler.drain();
    expect(staged).toEqual([
      {
        who: actor,
        data: expect.any(Buffer),
        contentType: 'image/jpeg',
        filename: 'image.jpeg',
        size: 10,
      },
    ]);
    expect(service.sends[0]).toMatchObject({
      message: 'what is this?',
      attachments: [{ mediaId: 'media-1' }],
    });
    expect(texts(outbox)).toEqual(['Nice picture.']);
  });

  it('refuses a type the attachment store does not take, without downloading it', async () => {
    const { handler, downloads, service, outbox } = mediaSetup();
    await handler.handle(
      request(
        inbound('', {
          media: [{ kind: 'audio', contentType: 'audio/ogg; codecs=opus', ref: { size: 5 } }],
        }),
      ),
    );
    await handler.drain();
    expect(downloads).toEqual([]);
    expect(service.sends).toEqual([]);
    expect(texts(outbox)).toEqual(['I cannot listen to audio messages. Please type your message.']);
  });

  it('refuses a type the store refuses once it is downloaded (the webhook did not say)', async () => {
    const { handler, outbox, service } = mediaSetup();
    await handler.handle(
      request(inbound('', { media: [{ kind: 'document', ref: { size: 5, type: 'text/html' } }] })),
    );
    await handler.drain();
    expect(service.sends).toEqual([]);
    expect(texts(outbox)).toEqual(['I cannot read this kind of file.']);
  });

  it('refuses a file past the limit — by its declared size, or while downloading', async () => {
    const { handler, downloads, service, outbox } = mediaSetup();
    await handler.handle(request(inbound('', { media: [photo(5000, { sizeBytes: 5000 })] })));
    await handler.handle(request(inbound('look', { media: [photo(5000)] })));
    await handler.drain();
    expect(downloads).toHaveLength(1);
    expect(texts(outbox).slice(0, 2)).toEqual([
      'That file is too large (the limit is 1 KB).',
      'That file is too large (the limit is 1 KB).',
    ]);
    // the caption still goes to the agent, without the file
    expect(service.sends.map((send) => [send.message, send.attachments])).toEqual([
      ['look', undefined],
    ]);
  });

  it('says so when attachments are off', async () => {
    const { handler, service, outbox } = mediaSetup({ attachments: false });
    await handler.handle(request(inbound('', { media: [photo(10)] })));
    await handler.drain();
    expect(service.sends).toEqual([]);
    expect(texts(outbox)).toEqual(['I can only read text messages here.']);
  });
});

// ── outcomes and the store ────────────────────────────────────────────────────

describe('outcomes after the turn', () => {
  const settled = (conversation: string, outcomeText?: string) =>
    ({
      id: `proposal-${conversation}`,
      threadId: 't',
      decision: 'approved',
      execution: { status: 'succeeded', generation: 1, lease: null },
      executionContext: {
        requestId: 'r',
        pageContext: { kind: 'outcomes', channel: { name: 'test', conversation } },
      },
      ...(outcomeText !== undefined ? { outcome: { text: outcomeText } } : {}),
    }) as unknown as ActionProposal;

  async function channelsService(adapter: ReturnType<typeof fakeAdapter>['adapter']) {
    const module = await Test.createTestingModule({
      imports: [
        AgentModule.forRoot({
          store: new InMemoryAgentStore(),
          actorResolver: { resolve: () => actor },
          model: new FakeModelProvider(() => ({ text: 'hi' })),
        }),
        AgentChannelsModule.forRoot({
          path: false,
          channels: [{ adapter, actor: () => actor, thread: () => 't' }],
        }),
      ],
    }).compile();
    return module.get(AgentChannelsService);
  }

  it('relays an executed proposal once, through the channel it was proposed on', async () => {
    const { adapter, outbox } = fakeAdapter();
    const channels = await channelsService(adapter);
    expect(await channels.deliverOutcome(settled('chat-9', 'Refunded **10.00**.'))).toBe(true);
    expect(await channels.deliverOutcome(settled('chat-9', 'Refunded **10.00**.'))).toBe(false);
    expect(outbox).toEqual([{ conversation: 'chat-9', message: { text: 'Refunded *10.00*.' } }]);
    expect(channels.adapter('test')).toBe(adapter);
  });

  it('ignores proposals from other surfaces and unknown channels; a failed one gets its text', async () => {
    const { adapter, outbox } = fakeAdapter();
    const channels = await channelsService(adapter);
    const web = {
      ...settled('x'),
      executionContext: { requestId: 'r', pageContext: { kind: 'web' } },
    } as ActionProposal;
    expect(await channels.deliverOutcome(web)).toBe(false);
    const elsewhere = settled('y');
    (elsewhere.executionContext?.pageContext?.channel as { name: string }).name = 'nobody';
    expect(await channels.deliverOutcome(elsewhere)).toBe(false);
    const failed = {
      ...settled('z'),
      execution: { status: 'failed', generation: 1, lease: null, error: 'x' },
    } as ActionProposal;
    expect(await channels.deliverOutcome(failed)).toBe(true);
    expect(texts(outbox)).toEqual(['The action could not be completed.']);
  });
});

describe('the default store', () => {
  it('is the one bound to AGENT_CHANNEL_STORE (the store modules bind theirs), else memory', async () => {
    const bound = new InMemoryChannelStore();
    @Global()
    @Module({
      providers: [{ provide: AGENT_CHANNEL_STORE, useValue: bound }],
      exports: [AGENT_CHANNEL_STORE],
    })
    class StoreModule {}
    const { adapter } = fakeAdapter();
    const module = await Test.createTestingModule({
      imports: [
        StoreModule,
        AgentModule.forRoot({
          store: new InMemoryAgentStore(),
          actorResolver: { resolve: () => actor },
          model: new FakeModelProvider(() => ({ text: 'hi' })),
        }),
        AgentChannelsModule.forRoot({
          path: false,
          channels: [{ adapter, actor: () => actor, thread: () => null }],
        }),
      ],
    }).compile();
    const app = module.createNestApplication();
    await app.init();
    try {
      const channels = app.get(AgentChannelsService);
      await channels.handleRequest('test', request(inbound('hello', { id: 'wamid.1' })));
      await channels.handleRequest('test', request(inbound('hello', { id: 'wamid.1' })));
      await channels.drain();
      expect(await bound.claim('test:wamid.1', 1000)).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('refuses two channels under one name', async () => {
    const { adapter } = fakeAdapter();
    await expect(
      Test.createTestingModule({
        imports: [
          AgentModule.forRoot({
            store: new InMemoryAgentStore(),
            actorResolver: { resolve: () => actor },
            model: new FakeModelProvider(() => ({ text: 'hi' })),
          }),
          AgentChannelsModule.forRoot({
            path: false,
            channels: [
              { adapter, actor: () => actor, thread: () => null },
              { adapter, actor: () => actor, thread: () => null },
            ],
          }),
        ],
      }).compile(),
    ).rejects.toThrow('Two channels are named "test"');
  });
});
