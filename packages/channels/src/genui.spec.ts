import { AgentModule } from '@dudousxd/nestjs-agent';
import { InMemoryAgentStore } from '@dudousxd/nestjs-agent-core';
import {
  type GenuiChannels,
  Sandbox,
  defineCatalog,
  defineComponent,
} from '@dudousxd/nestjs-agent-core/genui';
import { BUILTIN_COMPONENTS, LAYOUT_COMPONENTS } from '@dudousxd/nestjs-agent-core/genui/builtins';
import { FakeModelProvider } from '@dudousxd/nestjs-agent-testing';
import { AgentGenuiModule } from '@dudousxd/nestjs-agent/genui';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import http from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { telegram } from './adapters/telegram.js';
import { AgentChannelsModule } from './agent-channels.module.js';
import { AgentChannelsService } from './agent-channels.service.js';
import {
  type ScriptedFrame,
  actor,
  channel,
  fakeAdapter,
  fakeService,
  inbound,
  request,
} from './channels.spec-helper.js';
import type { ChannelCapabilities } from './types.js';

/** A component with a WhatsApp conversion: its orders as reply buttons (or a list past three). */
const OrderList = defineComponent<{ orders: { id: string; total: number }[] }>(
  {
    name: 'OrderList',
    title: 'Orders',
    description: 'A list of orders.',
    props: {
      type: 'object',
      properties: {
        orders: {
          type: 'array',
          items: {
            type: 'object',
            properties: { id: { type: 'string' }, total: { type: 'number' } },
            required: ['id', 'total'],
          },
        },
      },
      required: ['orders'],
    },
    fallbackText: (props) => props.orders.map((order) => `${order.id}: ${order.total}`).join('\n'),
  },
  {
    channels: {
      whatsapp: (props) => ({
        text: `You have ${props.orders.length} orders.`,
        buttons: props.orders.map((order) => ({
          label: `Refund ${order.id}`,
          action: 'refund',
          value: { orderId: order.id },
        })),
      }),
    },
  },
);

const catalog = defineCatalog([...BUILTIN_COMPONENTS, ...LAYOUT_COMPONENTS, OrderList, Sandbox]);

const channels: GenuiChannels = {
  web: { mode: 'tree', streaming: 'partial' },
  whatsapp: { mode: 'per-component' },
  telegram: { mode: 'per-component' },
  email: { mode: 'text' },
};

describe('a genui channel end to end (handler)', () => {
  const ordersFrame = (count: number): ScriptedFrame => ({
    kind: 'ui',
    id: 'call-1:ui:0',
    component: 'OrderList',
    props: {
      orders: Array.from({ length: count }, (_, index) => ({ id: `O${index}`, total: index })),
    },
    fallbackText: 'orders as text',
  });

  function whatsappHandler(
    frames: ScriptedFrame[],
    capabilities: Partial<ChannelCapabilities> = { buttons: 3, lists: 10 },
  ) {
    const { adapter, outbox } = fakeAdapter({ media: true, ...capabilities });
    const kinded = { ...adapter, kind: 'whatsapp' };
    const service = fakeService(frames);
    const handler = channel(kinded, service, { genui: { catalog, channels } });
    return { handler, outbox, service };
  }

  it('turns on a whatsapp channel carry its kind and no empty capabilities', async () => {
    const { handler, service } = whatsappHandler([{ kind: 'text', text: 'Hi' }]);
    await handler.handle(request(inbound('hello')));
    await handler.drain();
    expect(service.sends[0].pageContext.channel).toEqual({
      name: 'test',
      conversation: 'chat-1',
      kind: 'whatsapp',
    });
    expect(service.sends[0].uiCapabilities).toBeUndefined();
  });

  it('sends a component as reply buttons, in the order of the text, and a press is the next turn', async () => {
    const { handler, outbox, service } = whatsappHandler([
      { kind: 'text', text: 'Here they are.' },
      ordersFrame(2),
      { kind: 'text', text: 'Anything else?' },
    ]);
    await handler.handle(request(inbound('my orders')));
    await handler.drain();
    expect(outbox.map((item) => item.message.text)).toEqual([
      'Here they are.',
      'You have 2 orders.',
      'Anything else?',
    ]);
    const buttons = outbox[1]?.message.buttons ?? [];
    expect(buttons.map((button) => button.label)).toEqual(['Refund O0', 'Refund O1']);
    expect(buttons[0]?.id).toMatch(/^ui:[A-Za-z0-9_-]{16}$/);
    expect(outbox[1]?.message.fallbackText).toContain('1. Refund O0');

    await handler.handle(request(inbound('Refund O1', { buttonId: buttons[1]?.id as string })));
    await handler.drain();
    expect(service.sends).toHaveLength(2);
    const turn = service.sends[1].message as string;
    expect(turn).toContain('Refund O1');
    expect(turn).toContain('[UI action "refund" from UI');
    expect(turn).toContain('"orderId": "O1"');
  });

  it('more choices than buttons become a list message', async () => {
    const { handler, outbox } = whatsappHandler([ordersFrame(5)]);
    await handler.handle(request(inbound('my orders')));
    await handler.drain();
    const list = outbox[0]?.message.list;
    expect(list?.rows.map((row) => row.title)).toEqual([
      'Refund O0',
      'Refund O1',
      'Refund O2',
      'Refund O3',
      'Refund O4',
    ]);
    expect(list?.rows[0]?.id).toMatch(/^ui:/);
  });

  it('a channel with neither buttons nor lists gets numbered text', async () => {
    const { handler, outbox } = whatsappHandler([ordersFrame(5)], { buttons: 0, lists: 0 });
    await handler.handle(request(inbound('my orders')));
    await handler.drain();
    expect(outbox[0]?.message.text).toContain('5. Refund O4');
    expect(outbox[0]?.message.buttons).toBeUndefined();
  });

  it('a label-only press (Whatsmiau) finds the button by its label', async () => {
    const { handler, service } = whatsappHandler([ordersFrame(2)]);
    await handler.handle(request(inbound('my orders')));
    await handler.drain();
    await handler.handle(request(inbound('Refund O0', { buttonWithoutId: true })));
    await handler.drain();
    expect(service.sends[1].message).toContain('"orderId": "O0"');
  });

  it('without channels configured, a text channel works exactly as before', async () => {
    const { adapter, outbox } = fakeAdapter();
    const service = fakeService([ordersFrame(2)]);
    const handler = channel(adapter, service, { genui: { catalog } });
    await handler.handle(request(inbound('my orders')));
    await handler.drain();
    expect(service.sends[0].uiCapabilities).toEqual({ components: [] });
    expect(outbox.map((item) => item.message)).toEqual([{ text: 'orders as text' }]);
  });

  it('`genui: false` turns native drawing off for a configured channel', async () => {
    const { adapter, outbox } = fakeAdapter({ buttons: 3 });
    const service = fakeService([ordersFrame(2)]);
    const handler = channel({ ...adapter, kind: 'whatsapp' }, service, { genui: false });
    await handler.handle(request(inbound('my orders')));
    await handler.drain();
    expect(service.sends[0].uiCapabilities).toEqual({ components: [] });
    expect(outbox.map((item) => item.message)).toEqual([{ text: 'orders as text' }]);
  });
});

describe('AgentChannelsModule with AgentGenuiModule channels', () => {
  let app: NestExpressApplication | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("draws a component natively with the app's genui, and a press is the next turn", async () => {
    const outbox: { method: string; body: any }[] = [];
    const fetch = (async (url: string | URL, init?: RequestInit) => {
      outbox.push({
        method: String(url).split('/').at(-1) ?? '',
        body: JSON.parse(String(init?.body)),
      });
      return new Response('{"ok":true}', { status: 200 });
    }) as typeof globalThis.fetch;
    const seen: string[] = [];
    // The orders as Telegram buttons.
    const telegramOrders = defineComponent(OrderList, {
      channels: {
        telegram: (props) => ({
          text: 'Your orders',
          buttons: props.orders.map((order) => ({
            label: `Refund ${order.id}`,
            action: 'refund',
            value: { orderId: order.id },
          })),
        }),
      },
    });
    const module = await Test.createTestingModule({
      imports: [
        AgentModule.forRoot({
          store: new InMemoryAgentStore(),
          model: new FakeModelProvider((args, turn) => {
            const last = String(args.messages.at(-1)?.content);
            if (turn === 0) seen.push(last);
            return turn === 0 && last.includes('orders')
              ? {
                  text: '',
                  toolCall: {
                    name: 'ui__show_order_list',
                    input: { orders: [{ id: 'A1', total: 10 }] },
                  },
                }
              : { text: 'ok' };
          }),
          actorResolver: { resolve: () => ({ id: 'web' }) },
        }),
        AgentGenuiModule.forRoot({
          catalog: defineCatalog([telegramOrders]),
          channels: { telegram: {} },
          terminal: true,
        }),
        AgentChannelsModule.forRoot({
          channels: [
            {
              adapter: telegram({ botToken: '1:x', secretToken: 'tg', fetch }),
              actor: (message) => ({ id: `tg:${message.from}` }),
              thread: () => undefined,
            },
          ],
        }),
      ],
    }).compile();
    app = module.createNestApplication<NestExpressApplication>();
    await app.init();
    const channels = app.get(AgentChannelsService);
    const chat = { id: 42, type: 'private' };
    const post = (update: unknown) =>
      http((app as NestExpressApplication).getHttpServer())
        .post('/channels/telegram')
        .set('x-telegram-bot-api-secret-token', 'tg')
        .send(update as object)
        .expect(200);
    await post({
      update_id: 1,
      message: { message_id: 1, chat, from: { id: 42 }, text: 'my orders' },
    });
    await channels.drain();
    const drawn = outbox.find((item) => item.body.reply_markup !== undefined);
    expect(drawn?.body.text).toBe('Your orders');
    const keyboard = drawn?.body.reply_markup.inline_keyboard[0];
    expect(keyboard).toEqual([
      { text: 'Refund A1', callback_data: expect.stringMatching(/^ui:[A-Za-z0-9_-]{16}$/) },
    ]);

    await post({
      update_id: 2,
      callback_query: {
        id: 'cq',
        from: { id: 42 },
        data: keyboard[0].callback_data,
        message: { message_id: 2, chat, reply_markup: { inline_keyboard: [keyboard] } },
      },
    });
    await channels.drain();
    expect(seen).toHaveLength(2);
    expect(seen[1]).toContain('[UI action "refund" from UI');
    expect(seen[1]).toContain('"orderId": "A1"');
  });
});
