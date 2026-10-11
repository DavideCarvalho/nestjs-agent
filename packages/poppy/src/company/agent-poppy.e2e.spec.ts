import type { AddressInfo } from 'node:net';
import { AgentModule, type AgentModuleOptions, AiTool } from '@dudousxd/nestjs-agent';
import {
  AGENT_POPPY_STORE,
  InMemoryPoppyStore,
  PERSONAL_AGENT_ROLE,
  type PoppyEvent,
} from '@dudousxd/nestjs-agent-core';
import { InMemoryAgentStore } from '@dudousxd/nestjs-agent-testing';
import {
  type CanActivate,
  Controller,
  Get,
  Global,
  Injectable,
  Module,
  type ModuleMetadata,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { CompanyClient } from '../client/company.js';
import { ConversationClient } from '../client/conversations.js';
import { AgentPoppyModule } from './agent-poppy.module.js';
import type { AgentPoppyModuleOptions } from './agent-poppy.options.js';
import { POPPY_AUTHENTICATE_SLOT } from './auth.js';
import { PoppyConversations } from './conversations.js';
import { POPPY_ENDPOINTS_SLOT, announcedPoppyEndpoints } from './endpoints.js';
import {
  ChunkedModel,
  type Script,
  U1,
  auth,
  companyMessages,
  fakeResolver,
  get,
  msg,
  openSse,
  post,
  readUntil,
  seen,
  settled,
  sleep,
} from './poppy.spec-helper.js';

const ran: string[] = [];

@AiTool({
  name: 'store_hours',
  kind: 'read',
  description: 'Store hours',
  input: z.object({}),
  roles: [PERSONAL_AGENT_ROLE],
})
@Injectable()
class StoreHoursTool {
  async execute() {
    ran.push('store_hours');
    return { hours: '9-5' };
  }
}

@AiTool({
  name: 'list_orders',
  kind: 'read',
  description: 'List orders',
  input: z.object({}),
  roles: ['scope:poppy:read'],
})
@Injectable()
class ListOrdersTool {
  async execute() {
    ran.push('list_orders');
    return { orders: ['A-1'] };
  }
}

@AiTool({
  name: 'cancel_order',
  kind: 'action',
  description: 'Cancel an order',
  input: z.object({ id: z.string() }),
  roles: ['scope:poppy:write'],
})
@Injectable()
class CancelOrderTool {
  async execute({ id }: { id: string }) {
    ran.push(`cancel_order:${id}`);
    return { cancelled: id };
  }
}

/** Refuses everything: an app's global guard must not reach the Poppy endpoint. */
@Injectable()
class DenyAllGuard implements CanActivate {
  canActivate() {
    return false;
  }
}

@Controller('app')
class AppController {
  @Get('ping')
  ping() {
    return { pong: true };
  }
}

interface Booted {
  url: string;
  app: NestExpressApplication;
  model: ChunkedModel;
  conversations: PoppyConversations;
}

let app: NestExpressApplication | undefined;

afterEach(async () => {
  delete (globalThis as Record<symbol, unknown>)[POPPY_AUTHENTICATE_SLOT];
  delete (globalThis as Record<symbol, unknown>)[POPPY_ENDPOINTS_SLOT];
  // The test client keeps sockets it pre-opened without a request: don't wait for them to time out.
  app?.getHttpServer().closeAllConnections();
  await app?.close();
  app = undefined;
  ran.length = 0;
});

async function boot(
  script: Script,
  options: {
    poppy?: AgentPoppyModuleOptions | false;
    module?: NonNullable<ModuleMetadata['imports']>[number];
    agent?: Partial<AgentModuleOptions>;
    rawBody?: boolean;
    extraImports?: NonNullable<ModuleMetadata['imports']>;
  } = {},
): Promise<Booted> {
  const model = new ChunkedModel(script);
  const moduleRef = await Test.createTestingModule({
    imports: [
      AgentModule.forRoot({ model, store: new InMemoryAgentStore(), ...options.agent }),
      ...(options.extraImports ?? []),
      options.module ??
        AgentPoppyModule.forRoot(
          options.poppy === false ? {} : { authenticate: fakeResolver, ...options.poppy },
        ),
    ],
    controllers: [AppController],
    providers: [
      StoreHoursTool,
      ListOrdersTool,
      CancelOrderTool,
      { provide: APP_GUARD, useClass: DenyAllGuard },
    ],
  }).compile();
  const booted = moduleRef.createNestApplication<NestExpressApplication>(
    options.rawBody === true ? { rawBody: true } : {},
  );
  app = booted;
  await booted.listen(0, '127.0.0.1');
  const { port } = booted.getHttpServer().address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    app: booted,
    model,
    conversations: booted.get(PoppyConversations),
  };
}

const callThen =
  (name: string, input: unknown = {}): Script =>
  (_args, turn) =>
    turn === 0 ? { text: '', toolCall: { name, input } } : { text: 'done' };

describe('AgentPoppyModule over a booted Nest (Express) app', () => {
  it('mounts ahead of the router: guards do not apply, other routes are untouched, 404/405 inside', async () => {
    const h = await boot(() => ({ text: 'hi' }));
    // The app's own route still goes through its global guard.
    expect((await fetch(`${h.url}/app/ping`)).status).toBe(403);
    expect((await fetch(`${h.url}/elsewhere`)).status).toBe(404);
    // The endpoint does not: it is authenticated by its Session Token alone.
    expect((await post(h, '', msg('hi'))).status).toBe(201);
    const nope = await get(h, '/cnv_1/nope');
    expect(nope.status).toBe(404);
    expect(nope.body).toEqual({ error: 'not_found' });
    const wrong = await fetch(`${h.url}/poppy/conversations/cnv_1/events`, { method: 'POST' });
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get('allow')).toBe('GET');
  });

  it('create, answer, continue, read with cursor and wait', async () => {
    const h = await boot((args) => ({ text: `reply to ${args.messages.length}` }));
    const created = await post(h, '', msg('The jacket is not warm enough.'));
    expect(created.status).toBe(201);
    expect(created.body).toEqual({
      conversation_id: expect.stringMatching(/^cnv_/),
      status: 'working',
      responder: 'agent',
    });
    const id = created.body.conversation_id;
    const first = await readUntil(h, id, settled);
    expect(first.events.map((e) => e.type)).toEqual(['message', 'state', 'message', 'state']);
    expect(companyMessages(first.events)[0]?.message.text).toMatch(/^reply to/);

    const sent = await post(h, `/${id}/messages`, msg('Medium, please.', { sender: 'human' }));
    expect(sent.status).toBe(202);
    const after = await get(h, `/${id}/events?cursor=${first.last.cursor}&wait=5`);
    expect(after.status).toBe(200);
    expect(after.body.events[0]).toMatchObject({
      type: 'message',
      message: { role: 'user', sender: 'human', text: 'Medium, please.' },
    });
    await readUntil(h, id, (events) => companyMessages(events).length === 2);
  });

  it('streams SSE through Express: text-delta pieces, the message, resume with Last-Event-ID', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = await boot(async () => {
      await gate;
      return { chunks: ['I can ', 'do ', 'that.'] };
    });
    const id = (await post(h, '', msg('Exchange it?'))).body.conversation_id;
    const sse = await openSse(h, id);
    expect(sse.res.status).toBe(200);
    expect(sse.res.headers.get('content-type')).toBe('text/event-stream');
    await sse.until((items) => items.some((i) => i.data.type === 'state'));
    release();
    await sse.until((items) => items.some((i) => i.data.status === 'idle'));
    const deltas = sse.items.filter((i) => i.event === 'text-delta');
    expect(deltas.map((d) => d.data.text).join('')).toBe('I can do that.');
    const reply = sse.items.find(
      (i) => i.data.type === 'message' && i.data.message.role === 'company',
    );
    expect(new Set(deltas.map((d) => d.data.message_id))).toEqual(
      new Set([reply?.data.message.id]),
    );
    await sse.close();

    const firstId = sse.items.find((i) => i.data.type === 'message')?.id ?? '';
    const resumed = await openSse(h, id, { 'last-event-id': firstId });
    await resumed.until((items) => items.some((i) => i.data.status === 'idle'));
    expect(resumed.items.map((i) => i.data.type)).toEqual(['state', 'message', 'state']);
    await resumed.close();
  });

  it("authenticates before the body: Nest's parser refusing it still answers the token first", async () => {
    const h = await boot(() => ({ text: 'ok' }));
    const unauthenticated = await post(h, '', '{not json', {});
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.body).toEqual({ error: 'invalid_token' });
    const malformed = await post(h, '', '{not json');
    expect(malformed.status).toBe(400);
    expect(malformed.body.error).toBe('invalid_request');
    // A body Nest's parser leaves alone (not JSON) is read off the socket.
    const plain = await fetch(`${h.url}/poppy/conversations`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', ...U1 },
      body: JSON.stringify(msg('as text')),
    });
    expect(plain.status).toBe(201);
  });

  it('reads the raw body when the app keeps it (rawBody: true), within maxBodyBytes', async () => {
    const h = await boot(() => ({ text: 'ok' }), { rawBody: true, poppy: { maxBodyBytes: 200 } });
    expect((await post(h, '', msg('fits'))).status).toBe(201);
    const big = await post(h, '', msg('x'.repeat(500)));
    expect(big.status).toBe(413);
    expect(big.body.error).toBe('request_too_large');
  });

  it('idempotent message ids: a retry answers the same; different content is 409', async () => {
    const h = await boot(() => ({ text: 'once' }));
    const body = { message: { id: 'msg_same', sender: 'agent', text: 'hi' } };
    const a = await post(h, '', body);
    const b = await post(h, '', body);
    expect(b.status).toBe(201);
    expect(b.body).toEqual(a.body);
    const id = a.body.conversation_id;
    await readUntil(h, id, settled);
    const conflict = await post(h, '', { message: { ...body.message, text: 'other' } });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toBe('message_id_conflict');
    await sleep(50);
    expect(h.model.calls).toHaveLength(1);
  });

  it('handoff and close, with the injectable PoppyConversations driving the Company side', async () => {
    const forwarded: string[] = [];
    const h = await boot(() => ({ text: 'agent answer' }), {
      poppy: {
        handoff: {
          request: () => 'queued',
          message: ({ message }) => {
            forwarded.push(message.text ?? '');
          },
        },
      },
    });
    const id = (await post(h, '', msg('hi'))).body.conversation_id;
    await readUntil(h, id, settled);
    const queued = await post(h, `/${id}/handoff`, {});
    expect(queued.status).toBe(202);
    expect(queued.body).toEqual({ conversation_id: id, status: 'queued', responder: 'agent' });
    await post(h, `/${id}/messages`, msg('The order is A-1.'));
    expect(forwarded).toEqual(['The order is A-1.']);
    expect(await h.conversations.humanJoined(id)).toEqual({ status: 'idle', responder: 'human' });
    await h.conversations.postMessage(id, { sender: 'human', text: 'Hi, I am Sam.' });
    const closed = await post(h, `/${id}/close`, {});
    expect(closed.status).toBe(200);
    expect(closed.body).toEqual({ conversation_id: id, status: 'closed', responder: 'human' });
    const events = (await get(h, `/${id}/events`)).body.events as PoppyEvent[];
    expect(companyMessages(events).at(-1)?.message).toMatchObject({
      sender: 'human',
      text: 'Hi, I am Sam.',
    });
    expect(events.at(-1)).toMatchObject({ type: 'state', status: 'closed' });
  });

  it('a Direct Conversation runs in the parent thread and blocks the parent until closed', async () => {
    const h = await boot((args) => ({ text: `seen ${args.messages.length}` }));
    const parent = (await post(h, '', msg('exchange the jacket'))).body.conversation_id;
    await readUntil(h, parent, settled);
    await h.conversations.requestUser(parent, 'A specialist needs to confirm.');
    const direct = await post(h, '', {
      parent_conversation_id: parent,
      message: { id: 'msg_direct_e2e', sender: 'human', text: 'Hi, a question.' },
    });
    expect(direct.status).toBe(201);
    const directId = direct.body.conversation_id;
    await readUntil(h, directId, settled);
    expect(JSON.stringify(h.model.calls.at(-1)?.messages)).toContain('exchange the jacket');
    const blocked = await post(h, `/${parent}/messages`, msg('meanwhile'));
    expect(blocked.status).toBe(409);
    expect(blocked.body).toMatchObject({
      error: 'direct_conversation_open',
      conversation_id: directId,
    });
    expect((await post(h, `/${directId}/close`, {})).status).toBe(200);
    const parentEvents = (await get(h, `/${parent}/events`)).body.events as PoppyEvent[];
    expect(parentEvents.map((e) => e.type)).toEqual(
      expect.arrayContaining(['user_requested', 'direct_opened', 'direct_closed']),
    );
    expect((await post(h, `/${parent}/messages`, msg('back here'))).status).toBe(202);
  });

  it('a scope-gated tool is not run: an authorization event asks for the scope', async () => {
    const h = await boot(callThen('list_orders'));
    const id = (await post(h, '', msg('my orders?'))).body.conversation_id;
    const { events } = await readUntil(h, id, (e) => e.some((x) => x.type === 'authorization'));
    expect(ran).toEqual([]);
    expect(events.find((e) => e.type === 'authorization')).toMatchObject({
      error: 'sign_in_required',
      scope: 'poppy:read',
    });
  });

  it('a scope-granted action is approved by the scope and narrated (blocking approvals)', async () => {
    const h = await boot(callThen('cancel_order', { id: 'A-1' }));
    const writer = auth('u1|poppy:write|in|acct-1');
    const id = (await post(h, '', msg('cancel A-1'), writer)).body.conversation_id;
    const { events } = await readUntil(h, id, settled, writer);
    expect(ran).toEqual(['cancel_order:A-1']);
    expect(companyMessages(events).at(-1)?.message.text).toBe('done');
    expect(events.some((e) => e.type === 'authorization')).toBe(false);
  });

  it('a scope-granted action is approved, executed and narrated (independent approvals)', async () => {
    const h = await boot(callThen('cancel_order', { id: 'A-1' }), {
      agent: {
        actionApprovalMode: 'independent',
        // The worker runs the action as the actor the app resolves for its ref — here with the
        // personal agent's roles, which the tool requires.
        backgroundActorResolver: {
          resolve: async ({ actorRef }) => ({
            id: actorRef,
            roles: [PERSONAL_AGENT_ROLE, 'scope:poppy:write'],
          }),
        },
        actionProposalWorker: { pollIntervalMs: 10, leaseMs: 3000 },
      },
    });
    const writer = auth('u1|poppy:write|in|acct-1');
    const id = (await post(h, '', msg('cancel A-1'), writer)).body.conversation_id;
    const { events } = await readUntil(h, id, (e) => companyMessages(e).length > 0, writer, 8000);
    expect(ran).toEqual(['cancel_order:A-1']);
    const reply = companyMessages(events)[0]?.message;
    expect(reply?.data).toMatchObject({
      actions: [{ tool: 'cancel_order', status: 'succeeded', result: { cancelled: 'A-1' } }],
    });
    expect(reply?.text).toMatch(/cancel/i);
  });

  it('without a resolver the endpoint answers 501; the global slot is read per request', async () => {
    const h = await boot(() => ({ text: 'hi' }), { poppy: false });
    const disabled = await post(h, '', msg('hi'));
    expect(disabled.status).toBe(501);
    expect(disabled.body.error).toBe('not_implemented');
    (globalThis as Record<symbol, unknown>)[POPPY_AUTHENTICATE_SLOT] = fakeResolver;
    const enabled = await post(h, '', msg('hi'));
    expect(enabled.status).toBe(201);
    // The resolver gets the full public URL and the raw headers.
    expect(seen.request).toMatchObject({
      method: 'POST',
      url: `${h.url}/poppy/conversations`,
      headers: { authorization: 'DPoP u1||out' },
    });
  });

  it('with baseUrl: announces the endpoint at boot, and names it in the URL a proof is checked against', async () => {
    (globalThis as Record<symbol, unknown>)[POPPY_ENDPOINTS_SLOT] = { other: 'https://x/o' };
    const h = await boot(() => ({ text: 'hi' }), {
      poppy: { baseUrl: 'https://api.acme.com/', path: '/poppy/v1/' },
    });
    expect(announcedPoppyEndpoints()).toEqual({
      other: 'https://x/o',
      conversations: 'https://api.acme.com/poppy/v1',
    });
    const res = await fetch(`${h.url}/poppy/v1?wait=0`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...U1 },
      body: JSON.stringify(msg('hi')),
    });
    expect(res.status).toBe(201);
    expect(seen.request?.url).toBe('https://api.acme.com/poppy/v1?wait=0');
  });

  it('forRootAsync, and a store bound to AGENT_POPPY_STORE', async () => {
    const store = new InMemoryPoppyStore();
    @Global()
    @Module({
      providers: [{ provide: AGENT_POPPY_STORE, useValue: store }],
      exports: [AGENT_POPPY_STORE],
    })
    class StoreModule {}
    const h = await boot(() => ({ text: 'hi' }), {
      extraImports: [StoreModule],
      module: AgentPoppyModule.forRootAsync({
        useFactory: async () => ({ authenticate: fakeResolver, path: 'pa/conversations' }),
      }),
    });
    const res = await fetch(`${h.url}/pa/conversations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...U1 },
      body: JSON.stringify(msg('hi')),
    });
    expect(res.status).toBe(201);
    const { conversation_id } = (await res.json()) as { conversation_id: string };
    expect(await store.getConversation(conversation_id)).toMatchObject({
      clientId: expect.any(String),
    });
  });

  it("a personal agent's ConversationClient talks to the Nest endpoint", async () => {
    const h = await boot(() => ({ chunks: ['Hello ', 'from Nest.'] }));
    const company = {
      document: {
        agent: { protocols: [{ type: 'poppy', endpoint: `${h.url}/poppy/conversations` }] },
      },
      security: { insecureDev: true },
      state: { conversations: {} },
      agent: { log: () => {} },
      save: async () => {},
      fetch: (
        url: string,
        init: { method?: string; headers?: Record<string, string>; body?: string } = {},
      ) =>
        fetch(url, {
          method: init.method ?? 'GET',
          headers: { ...init.headers, ...U1 },
          ...(init.body !== undefined ? { body: init.body } : {}),
        }),
      async json(url: string, init: { headers?: Record<string, string> } = {}) {
        const res = await company.fetch(url, init);
        return { status: res.status, body: await res.json() };
      },
    };
    const client = new ConversationClient(company as unknown as CompanyClient);
    const started = await client.start({ id: 'msg_client_1', sender: 'agent', text: 'hi' });
    expect(started.status).toBe('working');
    const { events, state } = await client.collect(started.conversation_id, {
      timeoutMs: 5000,
      wait: 1,
    });
    expect(state.status).toBe('idle');
    expect(
      events
        .filter((e) => e.type === 'message' && e.message?.role === 'company')
        .map((e) => e.message?.text),
    ).toEqual(['Hello from Nest.']);
    // Another message, followed over SSE from the saved cursor.
    await client.send(started.conversation_id, {
      id: 'msg_client_2',
      sender: 'agent',
      text: 'more',
    });
    const followed: string[] = [];
    for await (const item of client.follow(started.conversation_id, { untilSettled: true })) {
      if (item.kind === 'event' && item.event.type === 'message') {
        followed.push(`${item.event.message?.role}:${item.event.message?.text}`);
      }
    }
    expect(followed).toEqual(['user:more', 'company:Hello from Nest.']);
    expect((await client.close(started.conversation_id)).status).toBe('closed');
  });
});
