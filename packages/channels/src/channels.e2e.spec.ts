import { createHmac } from 'node:crypto';
import { AgentModule, AiTool } from '@dudousxd/nestjs-agent';
import { InMemoryAgentStore } from '@dudousxd/nestjs-agent-core';
import { FakeModelProvider } from '@dudousxd/nestjs-agent-testing';
import { Injectable } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { telegram } from './adapters/telegram.js';
import { whatsappCloud } from './adapters/whatsapp-cloud.js';
import { AgentChannelsModule } from './agent-channels.module.js';
import { AgentChannelsService } from './agent-channels.service.js';

let refunds = 0;

@AiTool({
  name: 'refund',
  kind: 'action',
  description: 'Refund an order',
  input: z.object({ order: z.string() }),
})
@Injectable()
class RefundTool {
  async execute({ order }: { order: string }) {
    refunds += 1;
    return { refunded: order };
  }
}

interface Sent {
  method: string;
  body: any;
}

describe('AgentChannelsModule over a booted Nest app (independent approvals)', () => {
  let app: NestExpressApplication | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function boot() {
    refunds = 0;
    const store = new InMemoryAgentStore();
    const outbox: Sent[] = [];
    const fetch = (async (url: string | URL, init?: RequestInit) => {
      outbox.push({
        method: String(url).split('/').at(-1) ?? '',
        body: JSON.parse(String(init?.body)),
      });
      return new Response('{"ok":true,"messages":[{"id":"wamid.out"}]}', { status: 200 });
    }) as typeof globalThis.fetch;
    const threads = new Map<string, string>();
    const module = await Test.createTestingModule({
      imports: [
        AgentModule.forRoot({
          store,
          model: new FakeModelProvider((args, turn) =>
            turn === 0 && String(args.messages.at(-1)?.content).includes('refund')
              ? {
                  text: 'I prepared the **refund**.',
                  toolCall: { name: 'refund', input: { order: 'A-1' } },
                }
              : { text: 'ok' },
          ),
          actorResolver: { resolve: () => ({ id: 'web' }) },
          actionApprovalMode: 'independent',
          backgroundActorResolver: { resolve: async ({ actorRef }) => ({ id: actorRef }) },
          actionProposalWorker: { pollIntervalMs: 10, leaseMs: 3000 },
        }),
        AgentChannelsModule.forRoot({
          channels: [
            {
              adapter: telegram({ botToken: '1:x', secretToken: 'tg', fetch }),
              actor: (message) => ({ id: `tg:${message.from}` }),
              thread: (_actor, message) => threads.get(message.conversation),
              onThreadCreated: (threadId, _actor, message) => {
                threads.set(message.conversation, threadId);
              },
              // The outcome reaches the chat through the worker's settled hook, not the wait.
              outcomeTimeoutMs: 0,
            },
            {
              adapter: whatsappCloud({
                phoneNumberId: '123',
                accessToken: 'token',
                appSecret: 'meta-secret',
                verifyToken: 'verify-me',
                fetch,
              }),
              actor: (message) => ({ id: `wa:${message.from}` }),
              thread: (_actor, message) => threads.get(message.conversation),
              onThreadCreated: (threadId, _actor, message) => {
                threads.set(message.conversation, threadId);
              },
            },
          ],
        }),
      ],
      providers: [RefundTool],
    }).compile();
    // The raw body is what WhatsApp Cloud's signature is computed over.
    const booted = module.createNestApplication<NestExpressApplication>({ rawBody: true });
    app = booted;
    await booted.init();
    return {
      store,
      outbox,
      threads,
      channels: booted.get(AgentChannelsService),
      server: booted.getHttpServer(),
    };
  }

  it('runs a turn, offers the proposal as buttons, executes it on the press and relays the outcome', async () => {
    const { store, outbox, threads, channels, server } = await boot();
    const post = (update: unknown, secret = 'tg') =>
      request(server)
        .post('/channels/telegram')
        .set('x-telegram-bot-api-secret-token', secret)
        .send(update as object);
    const chat = { id: 42, type: 'private' };

    await post({ update_id: 1 }, 'wrong').expect(401);

    await post({
      update_id: 10,
      message: { message_id: 1, chat, from: { id: 42 }, text: 'refund A-1' },
    }).expect(200, { ok: true });
    await channels.drain();
    expect(refunds).toBe(0);
    expect(outbox.map((item) => item.body.text)).toEqual([
      'I prepared the *refund*\\.',
      expect.stringContaining('refund'),
    ]);
    const keyboard = outbox[1]?.body.reply_markup.inline_keyboard[0];
    expect(keyboard.map((button: { text: string }) => button.text)).toEqual(['Confirm', 'Cancel']);

    // Telegram retries the same update: nothing runs twice.
    await post({
      update_id: 10,
      message: { message_id: 1, chat, from: { id: 42 }, text: 'refund A-1' },
    }).expect(200);
    await channels.drain();
    expect(outbox).toHaveLength(2);

    outbox.length = 0;
    await post({
      update_id: 11,
      callback_query: {
        id: 'cq',
        from: { id: 42 },
        data: keyboard[0].callback_data,
        message: { message_id: 2, chat, reply_markup: { inline_keyboard: [keyboard] } },
      },
    }).expect(200);
    await channels.drain();
    // the module's proposal worker runs it, and its settled hook relays the outcome
    const deadline = Date.now() + 5000;
    while (outbox.length < 4 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    expect(refunds).toBe(1);
    expect(outbox.map((item) => item.method)).toEqual([
      'answerCallbackQuery',
      'editMessageReplyMarkup',
      'sendMessage',
      'sendMessage',
    ]);
    expect(outbox[2]?.body.text).toBe('Proposal approved and queued to run\\.');
    expect(outbox[3]?.body.text).toBe('Done\\.');

    const scope = { actorRef: 'tg:42', tenantRef: null, threadId: threads.get('42') ?? '' };
    const proposals = await store.listActionProposals(scope);
    expect(proposals[0]).toMatchObject({
      decision: 'approved',
      decisionAudit: expect.objectContaining({ via: 'telegram', actorRef: 'tg:42' }),
    });
    expect(proposals[0]?.executionContext?.pageContext).toMatchObject({
      kind: 'telegram',
      channel: { name: 'telegram', conversation: '42' },
    });
  }, 20_000);

  it('answers WhatsApp Cloud’s subscription check and verifies the signature over the raw body', async () => {
    const { outbox, channels, server } = await boot();
    await request(server)
      .get('/channels/whatsapp')
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'verify-me', 'hub.challenge': '1158' })
      .expect(200, '1158');

    // Spacing JSON.stringify would not reproduce: only the raw body matches the signature.
    const raw = `{ "object": "whatsapp_business_account", "entry": [{ "changes": [{ "field": "messages", "value": { "messaging_product": "whatsapp", "metadata": { "phone_number_id": "123" }, "messages": [{ "id": "wamid.in", "from": "5511999990000", "type": "text", "text": { "body": "hello" } }] } }] }] }`;
    const signature = `sha256=${createHmac('sha256', 'meta-secret').update(raw).digest('hex')}`;
    const post = (sig: string) =>
      request(server)
        .post('/channels/whatsapp')
        .set('content-type', 'application/json')
        .set('x-hub-signature-256', sig)
        .send(raw);
    await post('sha256=forged').expect(401);
    await post(signature).expect(200);
    await channels.drain();
    expect(outbox.map((item) => item.body.text?.body)).toEqual(['ok']);
  });

  it('answers 404 for a channel it does not have', async () => {
    const { server } = await boot();
    await request(server).post('/channels/sms').send({}).expect(404);
  });
});
