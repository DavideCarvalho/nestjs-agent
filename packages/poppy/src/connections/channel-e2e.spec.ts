import { AgentModule } from '@dudousxd/nestjs-agent';
import { AgentChannelsModule, AgentChannelsService } from '@dudousxd/nestjs-agent-channels';
import type {
  ChannelAdapter,
  InboundMessage,
  OutboundMessage,
} from '@dudousxd/nestjs-agent-channels';
import { InMemoryAgentStore, InMemoryPoppyConnectionStore } from '@dudousxd/nestjs-agent-core';
import { FakeModelProvider } from '@dudousxd/nestjs-agent-testing';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { generateEs256Key } from '../client/keys.js';
import { FakeCompany } from '../client/testing/fake-company.spec-helper.js';
import { AgentPoppyConnectionsModule } from './agent-poppy-connections.module.js';
import { SECRET, direct, freePort, required } from './connections.spec-helper.js';

vi.setConfig({ testTimeout: 30_000 });

let nest: INestApplication | undefined;
let company: FakeCompany | undefined;
afterEach(async () => {
  await nest?.close();
  await company?.stop();
  nest = undefined;
  company = undefined;
});

/** A WhatsApp-like adapter: what it sends lands in `outbox`. */
function whatsappLike() {
  const outbox: { conversation: string; message: OutboundMessage }[] = [];
  const adapter: ChannelAdapter = {
    name: 'test',
    capabilities: { markdown: 'whatsapp', maxLength: 4096, buttons: 3 },
    verify: () => true,
    parse: (body) => body as InboundMessage,
    send: async (conversation, message) => {
      outbox.push({ conversation, message });
    },
  };
  return { adapter, outbox };
}

/**
 * The connect flow over a text channel, end to end against the real modules: the connect card
 * arrives as one message with the link in full and no reply buttons; the sign-in at the company
 * decides it; once its outcome is in, the turn continues on its own and reaches the same
 * conversation (`AGENT_CHANNEL_FOLLOWER`).
 */
it('WhatsApp-like channel: link card → sign-in → the turn continues in the chat', async () => {
  company = await new FakeCompany().start();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const { adapter, outbox } = whatsappLike();
  const threads = new Map<string, string>();
  const actor = { id: 'wa:5511', roles: [] };
  const model = new FakeModelProvider((args) => {
    const users = args.messages.filter((m) => m.role === 'user' && m.content !== '');
    const last = String(users.at(-1)?.content ?? '');
    if (last.includes('I connected my account at Fake Co')) {
      return { text: 'Connected to Fake Co — ordering the boots now.' };
    }
    const lastUser = args.messages.lastIndexOf(required(users.at(-1)));
    if (args.messages.slice(lastUser + 1).some((m) => m.role === 'assistant'))
      return { text: 'Open the link to sign in.' };
    return { text: '', toolCall: { name: 'poppy_connect', input: { company: 'Fake Co' } } };
  });

  const module = await Test.createTestingModule({
    imports: [
      AgentModule.forRoot({
        model,
        store: new InMemoryAgentStore(),
        actorResolver: { resolve: () => actor },
        actionApprovalMode: 'independent',
        backgroundActorResolver: { resolve: async ({ actorRef }) => ({ id: actorRef, roles: [] }) },
        actionProposalWorker: { pollIntervalMs: 10, leaseMs: 3000 },
      }),
      AgentChannelsModule.forRoot({
        path: false,
        channels: [
          {
            adapter,
            actor: (message) => ({ id: `wa:${message.from}`, roles: [] }),
            thread: (_actor, message) => threads.get(message.conversation) ?? null,
            onThreadCreated: (threadId, _actor, message) => {
              threads.set(message.conversation, threadId);
            },
          },
        ],
      }),
      AgentPoppyConnectionsModule.forRoot({
        baseUrl: base,
        identity: {
          name: 'Acme Assistant',
          keys: [(await generateEs256Key()).privateJwk as Record<string, unknown>],
        },
        companies: [company.domain],
        store: new InMemoryPoppyConnectionStore(),
        secret: SECRET,
        insecureDev: true,
      }),
    ],
  }).compile();
  nest = module.createNestApplication({ logger: false });
  await nest.listen(port, '127.0.0.1');
  const channels = nest.get(AgentChannelsService);

  // The person asks on WhatsApp; the agent needs their account at the company.
  const asked: InboundMessage = {
    id: 'm-1',
    from: '5511',
    conversation: 'chat-1',
    text: 'order boots at Fake Co',
    raw: {},
  };
  await channels.handleRequest('test', {
    method: 'POST',
    url: '/channels/test',
    header: () => undefined,
    params: {},
    body: asked,
    rawBody: JSON.stringify(asked),
  });
  await channels.drain();
  const card = outbox.map((item) => item.message).find((m) => m.text?.includes('/connect/'));
  const text = required(card?.text, 'the connect card');
  const link = required(/(http:\/\/\S+\/poppy-agent\/connect\/[A-Za-z0-9_-]+)/.exec(text)?.[1]);
  // The link in full, what to do — and nothing to reply or press.
  expect(text).toContain('Open the link to continue.');
  // How long it works: the link's lifetime (15 min), which is also the card's.
  expect(text).toContain('The link works for up to 15 minutes.');
  expect(text).not.toMatch(/Reply \*/);
  expect(card).not.toHaveProperty('buttons');

  // They open it and sign in at the company.
  expect(await direct(link)).toContain('Connected to Fake Co');

  // The connect ran, its outcome was written, and the turn went on — in the same conversation.
  const deadline = Date.now() + 15_000;
  while (
    !outbox.some((item) => item.message.text?.includes('ordering the boots now')) &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  expect(outbox.some((item) => item.message.text?.includes('ordering the boots now'))).toBe(true);
  expect(outbox.every((item) => item.conversation === 'chat-1')).toBe(true);
  // Exactly once.
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(
    outbox.filter((item) => item.message.text?.includes('ordering the boots now')),
  ).toHaveLength(1);
});
