import {
  InMemoryPoppyStore,
  PERSONAL_AGENT_ROLE,
  type PoppyEvent,
} from '@dudousxd/nestjs-agent-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { PersonalAgentTurnService } from '../turn.js';
import { POPPY_AUTHENTICATE_SLOT } from './auth.js';
import { type PoppyConversationsOptions, poppyActorId } from './conversations.js';
import { publicOrigin } from './handler.js';
import {
  type Agent,
  CLIENT,
  type Harness,
  type Script,
  U1,
  auth,
  buildAgent,
  companyMessages,
  fakeResolver,
  get,
  msg,
  ndjson,
  openSse,
  post,
  readUntil,
  seen,
  serve,
  settled,
  sleep,
} from './poppy.spec-helper.js';

const agents: Agent[] = [];
const harnesses: Harness[] = [];

async function agentFor(script: Script) {
  const agent = await buildAgent(script);
  agents.push(agent);
  return agent;
}

async function served(...args: Parameters<typeof serve>) {
  const harness = await serve(...args);
  harnesses.push(harness);
  return harness;
}

async function setup(script: Script, extra: Partial<PoppyConversationsOptions> = {}) {
  const agent = await agentFor(script);
  const harness = await served({
    service: agent.service,
    toolRoles: (name) => agent.registry.spec(name)?.roles,
    ...extra,
  });
  return { ...harness, agent };
}

beforeEach(() => {
  (globalThis as Record<symbol, unknown>)[POPPY_AUTHENTICATE_SLOT] = fakeResolver;
});

afterEach(async () => {
  delete (globalThis as Record<symbol, unknown>)[POPPY_AUTHENTICATE_SLOT];
  for (const harness of harnesses.splice(0)) await harness.close();
  for (const agent of agents.splice(0)) await agent.close();
});

/** A fake turn service: a run whose stream is `events`, and nothing to settle. */
function fakeService(
  events: unknown[],
  extra: Partial<PersonalAgentTurnService> = {},
): PersonalAgentTurnService {
  return {
    chat: async () => ({ runId: 'r1', threadId: 'thread-1' }),
    subscribe: () => ndjson(events),
    approve: async () => {},
    reject: async () => {},
    skip: async () => {},
    cancel: async () => {},
    ...extra,
  } as unknown as PersonalAgentTurnService;
}

// ── routing and auth ──────────────────────────────────────────────────────────

describe('Poppy routing and auth', () => {
  it('leaves other paths alone; 404/405 inside the endpoint', async () => {
    const h = await setup(() => ({ text: 'hi' }));
    expect((await fetch(`${h.url}/elsewhere`)).status).toBe(418);
    expect((await get(h, '/cnv_1/nope')).status).toBe(404);
    const wrong = await fetch(`${h.url}/poppy/conversations/cnv_1/events`, { method: 'POST' });
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get('allow')).toBe('GET');
  });

  it('without a resolver the endpoint is disabled (501)', async () => {
    delete (globalThis as Record<symbol, unknown>)[POPPY_AUTHENTICATE_SLOT];
    const h = await setup(() => ({ text: 'hi' }));
    const res = await post(h, '', msg('hi'));
    expect(res.status).toBe(501);
    expect(res.body.error).toBe('not_implemented');
  });

  it('an explicit authenticate overrides the global slot', async () => {
    const agent = await agentFor(() => ({ text: 'hi' }));
    const h = await served(
      { service: agent.service, toolRoles: () => undefined },
      {
        authenticate: async () => ({
          ok: false,
          status: 401,
          error: 'invalid_token',
          wwwAuthenticate: 'DPoP error="invalid_token", error_description="custom"',
        }),
      },
    );
    const res = await post(h, '', msg('hi'));
    expect(res.headers.get('www-authenticate')).toContain('custom');
  });

  it('passes the resolver the full public URL, the raw headers, and no options', async () => {
    const h = await setup(() => ({ text: 'hi' }));
    await fetch(`${h.url}/poppy/conversations/cnv_x/events?cursor=evt_1&wait=0`, {
      headers: { ...U1, DPoP: 'proof.jwt' },
    });
    expect(seen.request).toMatchObject({
      method: 'GET',
      url: `${h.url}/poppy/conversations/cnv_x/events?cursor=evt_1&wait=0`,
      headers: { authorization: 'DPoP u1||out', dpop: 'proof.jwt' },
    });
    expect(seen.options).toBeUndefined();
  });

  it('forwards a refusal headers (DPoP-Nonce) and description, under its status', async () => {
    const h = await setup(() => ({ text: 'hi' }));
    const res = await post(h, '', msg('hi'), auth('nonce'));
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'use_dpop_nonce', error_description: 'Use the DPoP nonce' });
    expect(res.headers.get('dpop-nonce')).toBe('n-123');
    expect(res.headers.get('www-authenticate')).toBe('DPoP error="use_dpop_nonce"');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('answers the resolver refusal with its status, error and challenge — before reading the body', async () => {
    const h = await setup(() => ({ text: 'hi' }));
    const missing = await post(h, '', '{not json', {});
    expect(missing.status).toBe(401);
    expect(missing.body).toEqual({ error: 'invalid_token' });
    expect(missing.headers.get('www-authenticate')).toBe('DPoP error="invalid_token"');
    const forbidden = await post(h, '', msg('hi'), auth('forbidden'));
    expect(forbidden.status).toBe(403);
    expect(forbidden.body).toEqual({ error: 'insufficient_scope', scope: 'poppy:read' });
    expect(forbidden.headers.get('www-authenticate')).toContain('insufficient_scope');
  });
});

// ── messages ─────────────────────────────────────────────────────────────────

describe('Poppy messages (§7.3, §7.4)', () => {
  it('starts a conversation, answers it, and continues it', async () => {
    const h = await setup((args) => ({ text: `reply to ${args.messages.length}` }));
    const created = await post(h, '', msg('The jacket is not warm enough.'));
    expect(created.status).toBe(201);
    expect(created.body).toEqual({
      conversation_id: expect.stringMatching(/^cnv_[A-Za-z0-9_-]+$/),
      status: 'working',
      responder: 'agent',
    });
    const id = created.body.conversation_id;
    const first = await readUntil(h, id, settled);
    for (const event of first.events) {
      expect(event).toMatchObject({
        id: expect.stringMatching(/^evt_/),
        type: expect.any(String),
        created_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
      });
    }
    expect(first.events.map((e) => e.type)).toEqual(['message', 'state', 'message', 'state']);
    expect(first.events[0]?.message).toMatchObject({
      role: 'user',
      sender: 'agent',
      text: 'The jacket is not warm enough.',
    });
    expect(first.events[1]).toMatchObject({ status: 'working', responder: 'agent' });
    expect(companyMessages(first.events)[0]?.message).toMatchObject({
      role: 'company',
      sender: 'agent',
      text: expect.stringMatching(/^reply to/),
    });
    expect(first.last).toMatchObject({ status: 'idle', responder: 'agent', has_more: false });

    const second = await post(h, `/${id}/messages`, msg('Medium, please.', { sender: 'human' }));
    expect(second.status).toBe(202);
    expect(second.body).toEqual({ conversation_id: id, status: 'working', responder: 'agent' });
    const all = await readUntil(h, id, (events) => companyMessages(events).length === 2);
    expect(
      all.events.find((e) => (e.message as { text?: string })?.text === 'Medium, please.')?.message,
    ).toMatchObject({ sender: 'human' });
  });

  it('a POST with wait answers as a read, keeping its status code', async () => {
    const h = await setup(() => ({ text: 'quick' }));
    const res = await fetch(`${h.url}/poppy/conversations?wait=3`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...U1 },
      body: JSON.stringify(msg('hi')),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { events: { type: string }[] };
    expect(body).toMatchObject({
      conversation_id: expect.any(String),
      cursor: expect.any(String),
      has_more: false,
      status: expect.any(String),
      responder: 'agent',
    });
    expect(body.events[0]?.type).toBe('message');
  });

  it('a retried message (same id, same content) is accepted once — first message included', async () => {
    const h = await setup(() => ({ text: 'once' }));
    const body = { message: { id: 'msg_retry_1', sender: 'agent', text: 'hi' } };
    const a = await post(h, '', body);
    // Unknown fields are ignored (§3.3): still the same message.
    const b = await post(h, '', { ...body, future: 1, message: { ...body.message, x: 2 } });
    expect(b.status).toBe(201);
    expect(b.body).toEqual(a.body);
    const id = a.body.conversation_id;
    await readUntil(h, id, settled);

    const later = { message: { id: 'msg_retry_2', sender: 'agent', text: 'again' } };
    const c = await post(h, `/${id}/messages`, later);
    const d = await post(h, `/${id}/messages`, later);
    expect(d.status).toBe(202);
    expect(d.body).toEqual(c.body);
    await readUntil(h, id, (e) => companyMessages(e).length === 2);
    await sleep(100);
    const after = await get(h, `/${id}/events`);
    const userTexts = (after.body.events as PoppyEvent[])
      .filter((e) => (e.message as { role?: string })?.role === 'user')
      .map((e) => (e.message as { text?: string }).text);
    expect(userTexts).toEqual(['hi', 'again']);
    expect(h.agent.model.calls.length).toBe(2);
  });

  it('a reused id with different content is message_id_conflict (409)', async () => {
    const h = await setup(() => ({ text: 'ok' }));
    const a = await post(h, '', { message: { id: 'msg_c', sender: 'agent', text: 'one' } });
    const id = a.body.conversation_id;
    const b = await post(h, '', { message: { id: 'msg_c', sender: 'agent', text: 'two' } });
    expect(b.status).toBe(409);
    expect(b.body.error).toBe('message_id_conflict');
    // Unique per User, not per conversation.
    const c = await post(h, `/${id}/messages`, {
      message: { id: 'msg_c', sender: 'agent', text: 'one' },
    });
    expect(c.status).toBe(409);
    expect(c.body.error).toBe('message_id_conflict');
    // Another User may use the same id.
    const d = await post(
      h,
      '',
      { message: { id: 'msg_c', sender: 'agent', text: 'two' } },
      auth('u2||out'),
    );
    expect(d.status).toBe(201);
  });

  it('validates messages: a field is required, ids are URL-safe, JSON is JSON', async () => {
    const h = await setup(() => ({ text: 'ok' }));
    for (const body of [
      { message: { id: 'msg_v1', sender: 'agent' } },
      { message: { id: 'bad id!', sender: 'agent', text: 'x' } },
      { message: { id: 'msg_v2', sender: 'robot', text: 'x' } },
      { message: { id: 'msg_v3', sender: 'agent', data: [1] } },
      { message: { id: 'msg_v4', sender: 'agent', context: { user_available: 'yes' } } },
      {},
      '{',
    ]) {
      const res = await post(h, '', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error).toBe('invalid_request');
    }
  });

  it('a context-only message updates context without a turn; data reaches the model as JSON', async () => {
    const h = await setup(() => ({ text: 'ok' }));
    const created = await post(h, '', {
      message: { id: 'msg_ctx0', sender: 'agent', context: { locale: 'en-US', time_zone: 'UTC' } },
    });
    expect(created.body.status).toBe('idle');
    const id = created.body.conversation_id;
    await post(h, `/${id}/messages`, {
      message: { id: 'msg_ctx1', sender: 'agent', context: { user_available: false } },
    });
    await sleep(100);
    expect(h.agent.model.calls.length).toBe(0);
    expect((await h.store.getConversation(id))?.context).toEqual({
      locale: 'en-US',
      time_zone: 'UTC',
      user_available: false,
    });
    await post(h, `/${id}/messages`, {
      message: { id: 'msg_ctx2', sender: 'agent', text: 'Seats please', data: { seat: '14A' } },
    });
    await readUntil(h, id, (e) => companyMessages(e).length === 1);
    const sent = JSON.stringify(h.agent.model.calls[0]?.messages);
    expect(sent).toContain('Seats please');
    expect(sent).toContain('14A');
  });

  it('runs with the poppy page context, the turn text and the agent', async () => {
    const chats: Record<string, unknown>[] = [];
    const h = await served({
      service: fakeService([{ kind: 'text', text: 'ok' }], {
        chat: (async (params: Record<string, unknown>) => {
          chats.push(params);
          return { runId: `r${chats.length}`, threadId: 'thread-1' };
        }) as never,
      }),
      toolRoles: () => undefined,
      agentName: 'support',
    });
    const created = await post(h, '', {
      message: {
        id: 'msg_pc',
        sender: 'human',
        text: 'hi',
        data: { seat: '14A' },
        context: { locale: 'pt-BR' },
      },
    });
    const id = created.body.conversation_id;
    await readUntil(h, id, settled);
    expect(chats[0]).toMatchObject({
      actor: { id: poppyActorId(CLIENT, 'u1'), roles: [PERSONAL_AGENT_ROLE] },
      agentName: 'support',
      transient: true,
      message: expect.stringContaining('hi'),
      pageContext: {
        channel: 'poppy',
        poppy: {
          conversationId: id,
          direct: false,
          sender: 'human',
          signedIn: false,
          context: { locale: 'pt-BR' },
        },
      },
    });
    expect(chats[0]?.message).toContain('"seat": "14A"');
    // The next turn continues the thread the first one started.
    await post(h, `/${id}/messages`, msg('again'));
    await readUntil(h, id, (e) => companyMessages(e).length === 2);
    expect(chats[1]).toMatchObject({ threadId: 'thread-1' });
  });

  it('a failed turn says so and goes back to idle', async () => {
    const h = await setup(() => {
      throw new Error('model down');
    });
    const id = (await post(h, '', msg('hi'))).body.conversation_id;
    const { events } = await readUntil(h, id, settled);
    expect(companyMessages(events)[0]?.message.text).toMatch(/something went wrong/);
  });
});

// ── events ───────────────────────────────────────────────────────────────────

describe('Poppy events (§7.5)', () => {
  it('pages with cursor and has_more; an empty read keeps the cursor', async () => {
    const h = await setup(() => ({ text: 'ok' }));
    const created = await post(h, '', {
      message: { id: 'msg_p0', sender: 'agent', context: { locale: 'en' } },
    });
    const id = created.body.conversation_id;
    for (let i = 1; i <= 104; i++) {
      await post(h, `/${id}/messages`, {
        message: { id: `msg_p${i}`, sender: 'agent', context: { n: i } },
      });
    }
    const page1 = await get(h, `/${id}/events`);
    expect(page1.body.events).toHaveLength(100);
    expect(page1.body.has_more).toBe(true);
    expect(page1.body.cursor).toBe(page1.body.events[99].id);
    const page2 = await get(h, `/${id}/events?cursor=${page1.body.cursor}`);
    expect(page2.body.events).toHaveLength(5);
    expect(page2.body.has_more).toBe(false);
    const empty = await get(h, `/${id}/events?cursor=${page2.body.cursor}`);
    expect(empty.body).toEqual({
      conversation_id: id,
      events: [],
      cursor: page2.body.cursor,
      has_more: false,
      status: 'idle',
      responder: 'agent',
    });
  });

  it('invalid_cursor (400) and cursor_expired (410)', async () => {
    const h = await setup(() => ({ text: 'ok' }));
    const a = (await post(h, '', msg('a'))).body.conversation_id;
    const b = (await post(h, '', msg('b'))).body.conversation_id;
    const eventsOfB = await readUntil(h, b, settled);
    const unknown = await get(h, `/${a}/events?cursor=evt_zzz`);
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toBe('invalid_cursor');
    // Another conversation's cursor is not this one's.
    const foreign = await get(h, `/${a}/events?cursor=${eventsOfB.events[0]?.id}`);
    expect(foreign.status).toBe(400);
    expect(foreign.body.error).toBe('invalid_cursor');

    await h.store.pruneEvents(b, Date.now() + 1000);
    const expired = await get(h, `/${b}/events?cursor=${eventsOfB.events[0]?.id}`);
    expect(expired.status).toBe(410);
    expect(expired.body.error).toBe('cursor_expired');
    // Read from the beginning: what is left.
    const fresh = await get(h, `/${b}/events`);
    expect(fresh.status).toBe(200);
    expect(fresh.body.events).toHaveLength(1);
  });

  it('wait returns as soon as an event arrives, and an empty list on timeout', async () => {
    const h = await setup(() => ({ text: 'ok' }));
    const id = (await post(h, '', { message: { id: 'msg_w0', sender: 'agent', context: {} } })).body
      .conversation_id;
    const start = await get(h, `/${id}/events`);
    const startedAt = Date.now();
    const timedOut = await get(h, `/${id}/events?cursor=${start.body.cursor}&wait=0.3`);
    expect(timedOut.body.events).toEqual([]);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(250);
    const pending = get(h, `/${id}/events?cursor=${start.body.cursor}&wait=5`);
    await sleep(100);
    await post(h, `/${id}/messages`, {
      message: { id: 'msg_w1', sender: 'agent', context: { a: 1 } },
    });
    const woke = await pending;
    expect(woke.body.events[0].type).toBe('message');
  });
});

// ── streaming ────────────────────────────────────────────────────────────────

describe('Poppy streaming (§7.6)', () => {
  it('streams text-delta pieces, then the complete message; resumes after Last-Event-ID', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = await setup(async () => {
      await gate;
      return { chunks: ['I can ', 'do ', 'that.'] };
    });
    const id = (await post(h, '', msg('Exchange it?'))).body.conversation_id;
    const sse = await openSse(h, id);
    expect(sse.res.headers.get('content-type')).toBe('text/event-stream');
    await sse.until((items) => items.some((i) => i.data.type === 'state'));
    release();
    await sse.until((items) =>
      items.some((i) => i.data.type === 'message' && i.data.message.role === 'company'),
    );
    const deltas = sse.items.filter((i) => i.event === 'text-delta');
    expect(deltas.length).toBeGreaterThanOrEqual(3);
    for (const delta of deltas) expect(delta.id).toBeUndefined();
    const reply = sse.items.find(
      (i) => i.data.type === 'message' && i.data.message.role === 'company',
    );
    expect(reply?.id).toBe(reply?.data.id);
    expect(deltas.map((d) => d.data.text).join('')).toBe('I can do that.');
    expect(new Set(deltas.map((d) => d.data.message_id))).toEqual(
      new Set([reply?.data.message.id]),
    );
    expect(reply?.data.message.text).toBe('I can do that.');
    // Deltas come before the message they make up.
    const lastDelta = deltas.at(-1);
    expect(sse.items.indexOf(lastDelta as never)).toBeLessThan(sse.items.indexOf(reply as never));
    await sse.until((items) =>
      items.some((i) => i.data.type === 'state' && i.data.status === 'idle'),
    );
    await sse.close();

    // Reconnect from the user's message: everything after it again, no deltas.
    const firstId = sse.items.find((i) => i.data.type === 'message')?.id ?? '';
    const resumed = await openSse(h, id, { 'last-event-id': firstId });
    await resumed.until((items) => items.some((i) => i.data.status === 'idle'));
    expect(resumed.items.map((i) => i.data.type)).toEqual(['state', 'message', 'state']);
    expect(resumed.items.some((i) => i.event === 'text-delta')).toBe(false);
    await resumed.close();
  });

  it('a bad Last-Event-ID is a JSON error, and the stream ends once the conversation closes', async () => {
    const h = await setup(() => ({ text: 'ok' }));
    const id = (await post(h, '', msg('hi'))).body.conversation_id;
    const bad = await fetch(`${h.url}/poppy/conversations/${id}/events`, {
      headers: { ...U1, accept: 'text/event-stream', 'last-event-id': 'evt_nope' },
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe('invalid_cursor');
    const sse = await openSse(h, id);
    await sse.until((items) => items.some((i) => i.data.status === 'idle'));
    await post(h, `/${id}/close`, {});
    await sse.until((items) => items.some((i) => i.data.status === 'closed'));
    const deadline = Date.now() + 2000;
    while (!sse.done && Date.now() < deadline) await sleep(10);
    expect(sse.done).toBe(true);
  });
});

// ── scopes ───────────────────────────────────────────────────────────────────

describe('Poppy scopes (§7.11)', () => {
  async function withTools(script: Script) {
    const h = await setup(script);
    const ran: string[] = [];
    h.agent.registry.register(
      {
        name: 'list_orders',
        kind: 'read',
        description: 'List orders',
        inputSchema: z.object({}),
        roles: ['scope:poppy:read'],
      },
      {
        execute: async () => {
          ran.push('list_orders');
          return { orders: ['A-1'] };
        },
      },
    );
    h.agent.registry.register(
      {
        name: 'cancel_order',
        kind: 'action',
        description: 'Cancel an order',
        inputSchema: z.object({ id: z.string() }),
        roles: ['scope:poppy:write'],
      },
      {
        execute: async (input) => {
          ran.push(`cancel_order:${(input as { id: string }).id}`);
          return { ok: true };
        },
      },
    );
    h.agent.registry.register(
      {
        name: 'store_hours',
        kind: 'read',
        description: 'Store hours',
        inputSchema: z.object({}),
        roles: [PERSONAL_AGENT_ROLE],
      },
      {
        execute: async () => {
          ran.push('store_hours');
          return { hours: '9-5' };
        },
      },
    );
    return { ...h, ran };
  }

  const callThen =
    (name: string, input: unknown = {}): Script =>
    (_args, turn) =>
      turn === 0 ? { text: '', toolCall: { name, input } } : { text: 'done' };

  it('signed out: general tools run; an account read is not run and asks to sign in', async () => {
    const h = await withTools(callThen('list_orders'));
    const id = (await post(h, '', msg('my orders?'))).body.conversation_id;
    const { events } = await readUntil(h, id, (e) => e.some((x) => x.type === 'authorization'));
    expect(h.ran).toEqual([]);
    expect(events.find((e) => e.type === 'authorization')).toMatchObject({
      error: 'sign_in_required',
      scope: 'poppy:read',
    });

    const h2 = await withTools(callThen('store_hours'));
    const id2 = (await post(h2, '', msg('hours?'))).body.conversation_id;
    await readUntil(h2, id2, settled);
    expect(h2.ran).toEqual(['store_hours']);
  });

  it('read scope only: a change is not executed, and the authorization event names poppy:write', async () => {
    const h = await withTools(callThen('cancel_order', { id: 'A-1' }));
    const reader = auth('u1|poppy:read|in|acct-1');
    const id = (await post(h, '', msg('cancel A-1'), reader)).body.conversation_id;
    const { events } = await readUntil(
      h,
      id,
      (e) => e.some((x) => x.type === 'authorization') && settled(e),
      reader,
    );
    expect(h.ran).toEqual([]);
    expect(events.find((e) => e.type === 'authorization')).toMatchObject({
      error: 'insufficient_scope',
      scope: 'poppy:write',
    });
  });

  it('write scope: the action runs, approved by the token scope', async () => {
    const h = await withTools(callThen('cancel_order', { id: 'A-1' }));
    const writer = auth('u1|poppy:read,poppy:write|in|acct-1');
    const id = (await post(h, '', msg('cancel A-1'), writer)).body.conversation_id;
    const { events } = await readUntil(h, id, settled, writer);
    expect(h.ran).toEqual(['cancel_order:A-1']);
    expect(events.some((e) => e.type === 'authorization')).toBe(false);
  });

  it('runs as the account when signed in, as toActor when given, and poppy:<hash> signed out', async () => {
    const actors: { id: string; roles?: string[] }[] = [];
    const h = await setup(callThen('whoami'));
    h.agent.registry.register(
      {
        name: 'whoami',
        kind: 'read',
        description: 'x',
        inputSchema: z.object({}),
        roles: [PERSONAL_AGENT_ROLE],
      },
      {
        execute: async (_input, ctx) => {
          actors.push(ctx.actor);
          return {};
        },
      },
    );
    for (const token of [
      'u1|poppy:read|in|acct-1',
      'u2|poppy:read|in|acct-2|profile-9',
      'u3||out',
    ]) {
      const id = (await post(h, '', msg('who?'), auth(token))).body.conversation_id;
      await readUntil(h, id, settled, auth(token));
    }
    expect(actors.map((a) => a.id)).toEqual(['acct-1', 'profile-9', poppyActorId(CLIENT, 'u3')]);
    expect(actors[0]?.roles).toEqual([PERSONAL_AGENT_ROLE, 'scope:poppy:read']);
    expect(actors[2]?.roles).toEqual([PERSONAL_AGENT_ROLE]);
  });

  it('once used signed in, the conversation belongs to the account', async () => {
    const h = await withTools(() => ({ text: 'ok' }));
    const acct = auth('u1|poppy:read|in|acct-1');
    const id = (await post(h, '', msg('hi'), acct)).body.conversation_id;
    await readUntil(h, id, settled, acct);
    const signedOut = await get(h, `/${id}/events`, auth('u1||out'));
    expect(signedOut.status).toBe(403);
    expect(signedOut.body.error).toBe('sign_in_required');
    expect(signedOut.headers.get('www-authenticate')).toBe('DPoP error="sign_in_required"');
    const otherAccount = await get(h, `/${id}/events`, auth('u1|poppy:read|in|acct-2'));
    expect(otherAccount.status).toBe(404);
    expect(otherAccount.body.error).toBe('conversation_not_found');
  });

  it('another User or Personal Agent sees conversation_not_found', async () => {
    const h = await withTools(() => ({ text: 'ok' }));
    const id = (await post(h, '', msg('hi'))).body.conversation_id;
    for (const path of [`/${id}/events`, '/cnv_unknown/events', '/bad%20id/events']) {
      const res = await get(h, path, auth('u2||out'));
      expect(res.status, path).toBe(404);
      expect(res.body.error).toBe('conversation_not_found');
    }
    const send = await post(h, `/${id}/messages`, msg('x'), auth('u2||out'));
    expect(send.status).toBe(404);
  });
});

// ── proposals and components ─────────────────────────────────────────────────

describe('Poppy actions and components', () => {
  /** A one-proposal run: the model says `said`, the proposal ends `execution` / `decision`. */
  const proposalService = (opts: {
    said?: string;
    execution: { status: string; result?: unknown; error?: string };
    outcomeText?: string;
    detail?: string;
    decided?: { decision: string; via: string }[];
  }) => {
    let decision = 'pending';
    return fakeService(
      [
        ...(opts.said ? [{ kind: 'text', text: opts.said }] : []),
        {
          kind: 'tool-input-available',
          id: 'c1',
          name: 'cancel_order',
          input: { id: 'A-1' },
          toolKind: 'action',
        },
        {
          kind: 'approval-requested',
          id: 'c1',
          approver: 'requester',
          target: { kind: 'proposal', proposalId: 'p1' },
        },
      ],
      {
        decideActionProposal: (async (
          _actor: unknown,
          _thread: string,
          _id: string,
          body: { decision: string; via: string },
        ) => {
          decision = body.decision;
          opts.decided?.push({ decision: body.decision, via: body.via });
          return { status: 'applied' };
        }) as never,
        listActionProposals: (async () => [
          {
            id: 'p1',
            input: { id: 'A-1' },
            confirmation: {
              title: 'Cancel order A-1?',
              ...(opts.detail !== undefined ? { detail: opts.detail } : {}),
              verb: 'Cancel',
            },
            decision,
            execution: decision === 'approved' ? opts.execution : null,
            ...(opts.outcomeText ? { outcome: { text: opts.outcomeText } } : {}),
          },
        ]) as never,
      },
    );
  };
  const writeRoles = (name: string) =>
    name === 'cancel_order' ? ['scope:poppy:write'] : undefined;
  const writer = auth('u1|poppy:read,poppy:write|in|acct-1');

  it('an independent proposal is approved by the write scope and returned as data', async () => {
    const decided: { decision: string; via: string }[] = [];
    const h = await served({
      service: proposalService({
        execution: { status: 'succeeded', result: { cancelled: 'A-1' } },
        outcomeText: 'Order A-1 cancelled.',
        decided,
      }),
      toolRoles: writeRoles,
    });
    const id = (await post(h, '', msg('cancel A-1'), writer)).body.conversation_id;
    const { events } = await readUntil(h, id, (e) => companyMessages(e).length > 0, writer);
    expect(decided).toEqual([{ decision: 'approved', via: 'poppy' }]);
    expect(companyMessages(events)[0]?.message).toMatchObject({
      text: 'Order A-1 cancelled.',
      data: {
        actions: [
          {
            tool: 'cancel_order',
            status: 'succeeded',
            summary: { title: 'Cancel order A-1?' },
            result: { cancelled: 'A-1' },
          },
        ],
      },
    });
  });

  it('an executed action with no words from the model or the app is told by its summary', async () => {
    const h = await served({
      service: proposalService({ execution: { status: 'succeeded' }, detail: 'Order A-1, $70' }),
      toolRoles: writeRoles,
    });
    const id = (await post(h, '', msg('cancel A-1'), writer)).body.conversation_id;
    const { events } = await readUntil(h, id, (e) => companyMessages(e).length > 0, writer);
    expect(companyMessages(events)[0]?.message.text).toBe('Done: Cancel order A-1\nOrder A-1, $70');
  });

  it('an action that did not run replaces what the model claimed, and is a failed action', async () => {
    const h = await served({
      service: proposalService({
        said: 'Done, order A-1 is cancelled!',
        execution: { status: 'failed', error: 'already shipped' },
        detail: 'Order A-1, $70',
      }),
      toolRoles: writeRoles,
    });
    const id = (await post(h, '', msg('cancel A-1'), writer)).body.conversation_id;
    const { events } = await readUntil(h, id, (e) => companyMessages(e).length > 0, writer);
    const message = companyMessages(events)[0]?.message;
    expect(message?.text).toBe('This could not be done: Cancel order A-1\nOrder A-1, $70');
    expect(message?.data).toMatchObject({
      actions: [{ tool: 'cancel_order', status: 'failed', error: 'already shipped' }],
    });
  });

  it("actions: 'reject' tells the refused action; formatAction words it the app's way", async () => {
    const h = await served({
      service: proposalService({ execution: { status: 'succeeded' } }),
      toolRoles: writeRoles,
      actions: 'reject',
      formatAction: (action) => `[${action.status}] ${action.summary.title}`,
    });
    const id = (await post(h, '', msg('cancel A-1'), writer)).body.conversation_id;
    const { events } = await readUntil(h, id, (e) => companyMessages(e).length > 0, writer);
    expect(companyMessages(events)[0]?.message.text).toBe('[rejected] Cancel order A-1?');
  });

  it('a component becomes data, with its fallback as the text', async () => {
    const h = await served({
      service: fakeService([
        {
          kind: 'ui',
          id: 'c1:ui:0',
          component: 'order_card',
          props: { id: 'A-1' },
          fallbackText: 'Order A-1: shipped.',
        },
        { kind: 'ui', id: 'c1:ui:1', component: 'preview', props: {}, partial: true },
      ]),
      toolRoles: () => undefined,
    });
    const id = (await post(h, '', msg('status?'))).body.conversation_id;
    const { events } = await readUntil(h, id, (e) => companyMessages(e).length > 0);
    expect(companyMessages(events)[0]?.message).toEqual({
      id: expect.stringMatching(/^msg_/),
      role: 'company',
      sender: 'agent',
      text: 'Order A-1: shipped.',
      data: {
        components: [
          { name: 'order_card', props: { id: 'A-1' }, fallback_text: 'Order A-1: shipped.' },
        ],
      },
    });
  });

  it('a busy thread (run_active) is waited for, then answered', async () => {
    let attempts = 0;
    const h = await served({
      service: fakeService([{ kind: 'text', text: 'after the wait' }], {
        chat: async () => {
          attempts += 1;
          if (attempts < 3) {
            // `AgentService.chat`'s refusal: a ConflictException whose body carries the code.
            const error = new Error('thread busy') as Error & { getResponse(): unknown };
            error.getResponse = () => ({ statusCode: 409, code: 'run_active' });
            throw error;
          }
          return { runId: 'r1', threadId: 'thread-1' };
        },
      }),
      toolRoles: () => undefined,
    });
    const id = (await post(h, '', msg('hi'))).body.conversation_id;
    const { events } = await readUntil(h, id, (e) => companyMessages(e).length > 0);
    expect(companyMessages(events)[0]?.message.text).toBe('after the wait');
    expect(attempts).toBe(3);
  });
});

// ── handoff and close ────────────────────────────────────────────────────────

describe('Poppy handoff (§7.9) and close (§7.12)', () => {
  it('without handoff hooks, the Company Agent says no one is available', async () => {
    const h = await setup(() => ({ text: 'ok' }));
    const id = (await post(h, '', msg('hi'))).body.conversation_id;
    await readUntil(h, id, settled);
    const res = await post(h, `/${id}/handoff`, {});
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ conversation_id: id, status: 'idle', responder: 'agent' });
    const after = await get(h, `/${id}/events`);
    expect(companyMessages(after.body.events).at(-1)?.message).toMatchObject({
      sender: 'agent',
      text: 'No one is available to take this conversation right now.',
    });
  });

  it('queued → a person joins → their messages → they leave → close cancels', async () => {
    const forwarded: string[] = [];
    const cancelled: string[] = [];
    const h = await setup(() => ({ text: 'agent answer' }), {
      handoff: {
        request: () => 'queued',
        message: ({ message }) => {
          forwarded.push(message.text ?? '');
        },
        cancel: ({ conversationId }) => {
          cancelled.push(conversationId);
        },
      },
    });
    const id = (await post(h, '', msg('hi'))).body.conversation_id;
    await readUntil(h, id, settled);
    const queued = await post(h, `/${id}/handoff`, {});
    expect(queued.body).toEqual({ conversation_id: id, status: 'queued', responder: 'agent' });
    const callsBefore = h.agent.model.calls.length;
    const waiting = await post(h, `/${id}/messages`, msg('The order is A-1.'));
    expect(waiting.body.status).toBe('queued');
    expect(forwarded).toEqual(['The order is A-1.']);
    expect(await h.conversations.humanJoined(id)).toEqual({ status: 'idle', responder: 'human' });
    await h.conversations.postMessage(id, { text: 'Hi, I am Sam.', sender: 'human' });
    await post(h, `/${id}/messages`, msg('Medium.'));
    expect(forwarded).toEqual(['The order is A-1.', 'Medium.']);
    await sleep(100);
    expect(h.agent.model.calls.length).toBe(callsBefore);

    const events = (await get(h, `/${id}/events`)).body.events as PoppyEvent[];
    const states = events
      .filter((e) => e.type === 'state')
      .map((e) => `${e.status}/${e.responder}`);
    expect(states).toEqual(['working/agent', 'idle/agent', 'queued/agent', 'idle/human']);
    expect(companyMessages(events).at(-1)?.message).toMatchObject({
      sender: 'human',
      text: 'Hi, I am Sam.',
    });

    const closed = await post(h, `/${id}/close`, {});
    expect(closed.status).toBe(200);
    expect(closed.body).toEqual({ conversation_id: id, status: 'closed', responder: 'human' });
    expect(cancelled).toEqual([id]);
  });

  it('a hook that finds no one: back to idle with the reason; a person leaving gives it back', async () => {
    const h = await setup(() => ({ text: 'ok' }), {
      handoff: { request: () => ({ unavailable: 'Our team is offline until 9am.' }) },
    });
    const id = (await post(h, '', msg('hi'))).body.conversation_id;
    await readUntil(h, id, settled);
    const res = await post(h, `/${id}/handoff`, {});
    expect(res.body).toMatchObject({ status: 'idle', responder: 'agent' });
    const events = (await get(h, `/${id}/events`)).body.events as PoppyEvent[];
    expect(events.slice(-3).map((e) => e.type)).toEqual(['state', 'message', 'state']);
    expect(companyMessages(events).at(-1)?.message.text).toBe('Our team is offline until 9am.');

    const joined = await setup(() => ({ text: 'back to the agent' }), {
      handoff: { request: () => 'joined' },
    });
    const id2 = (await post(joined, '', msg('hi'))).body.conversation_id;
    await readUntil(joined, id2, settled);
    expect((await post(joined, `/${id2}/handoff`, {})).body.responder).toBe('human');
    await joined.conversations.humanLeft(id2);
    await post(joined, `/${id2}/messages`, msg('still there?'));
    const later = await readUntil(joined, id2, (e) => companyMessages(e).length === 2);
    expect(companyMessages(later.events).at(-1)?.message.text).toBe('back to the agent');
  });

  it('closed: no more messages or handoffs (409), events stay readable, close is idempotent', async () => {
    const h = await setup(() => ({ text: 'ok' }));
    const id = (await post(h, '', msg('hi'))).body.conversation_id;
    await readUntil(h, id, settled);
    expect((await post(h, `/${id}/close`, {})).status).toBe(200);
    for (const path of [`/${id}/messages`, `/${id}/handoff`]) {
      const res = await post(h, path, path.endsWith('handoff') ? {} : msg('more'));
      expect(res.status, path).toBe(409);
      expect(res.body.error).toBe('conversation_closed');
    }
    const read = await get(h, `/${id}/events`);
    expect(read.body.status).toBe('closed');
    expect(read.body.events.at(-1)).toMatchObject({ type: 'state', status: 'closed' });
    const again = await post(h, `/${id}/close`, {});
    expect(again.status).toBe(200);
    const reread = await get(h, `/${id}/events`);
    expect(reread.body.events).toHaveLength(read.body.events.length);
  });
});

// ── direct conversations ─────────────────────────────────────────────────────

describe('Poppy Direct Conversations (§7.10)', () => {
  it('user_requested, open a Direct Conversation on the same thread, parent blocked, close', async () => {
    const opened: string[] = [];
    const closedHooks: string[] = [];
    const h = await setup((args) => ({ text: `seen ${args.messages.length}` }), {
      direct: {
        opened: ({ conversationId, parentId }) => {
          opened.push(`${parentId}>${conversationId}`);
        },
        closed: ({ conversationId }) => {
          closedHooks.push(conversationId);
        },
      },
    });
    const parent = (await post(h, '', msg('exchange the jacket'))).body.conversation_id;
    await readUntil(h, parent, settled);
    await h.conversations.requestUser(parent, 'A specialist needs to confirm the exchange.');
    const requested = await get(h, `/${parent}/events`);
    expect(requested.body.events.at(-1)).toMatchObject({
      type: 'user_requested',
      reason: 'A specialist needs to confirm the exchange.',
    });

    const direct = await post(h, '', {
      parent_conversation_id: parent,
      message: { id: 'msg_direct_1', sender: 'human', text: 'Hi, I have a question.' },
    });
    expect(direct.status).toBe(201);
    const directId = direct.body.conversation_id;
    expect(directId).not.toBe(parent);
    expect(opened).toEqual([`${parent}>${directId}`]);
    const parentEvents = (await get(h, `/${parent}/events`)).body.events as PoppyEvent[];
    expect(parentEvents.at(-1)).toMatchObject({ type: 'direct_opened', conversation_id: directId });

    // The Direct Conversation answers in the parent's thread: the model sees the earlier history.
    await readUntil(h, directId, settled);
    const directCall = h.agent.model.calls.at(-1);
    expect(JSON.stringify(directCall?.messages)).toContain('exchange the jacket');
    expect((await h.store.getConversation(directId))?.threadId).toBe(
      (await h.store.getConversation(parent))?.threadId,
    );

    for (const [path, body] of [
      [`/${parent}/messages`, msg('meanwhile')],
      [`/${parent}/handoff`, {}],
    ] as const) {
      const res = await post(h, path, body);
      expect(res.status, path).toBe(409);
      expect(res.body).toMatchObject({
        error: 'direct_conversation_open',
        conversation_id: directId,
      });
    }
    const second = await post(h, '', { parent_conversation_id: parent, ...msg('another') });
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('direct_conversation_open');
    const nested = await post(h, '', { parent_conversation_id: directId, ...msg('nested') });
    expect(nested.status).toBe(404);
    // The parent can still be read.
    expect((await get(h, `/${parent}/events`)).status).toBe(200);

    expect((await post(h, `/${directId}/close`, {})).status).toBe(200);
    expect(closedHooks).toEqual([directId]);
    const afterClose = (await get(h, `/${parent}/events`)).body.events as PoppyEvent[];
    expect(afterClose.at(-1)).toMatchObject({ type: 'direct_closed', conversation_id: directId });
    expect((await post(h, `/${parent}/messages`, msg('back here'))).status).toBe(202);
  });

  it('unknown or closed parents; closing the parent closes its Direct Conversation', async () => {
    const h = await setup(() => ({ text: 'ok' }));
    const unknown = await post(h, '', { parent_conversation_id: 'cnv_nope', ...msg('x') });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error).toBe('conversation_not_found');

    const closedParent = (await post(h, '', msg('a'))).body.conversation_id;
    await post(h, `/${closedParent}/close`, {});
    const onClosed = await post(h, '', { parent_conversation_id: closedParent, ...msg('x') });
    expect(onClosed.status).toBe(409);
    expect(onClosed.body.error).toBe('conversation_closed');

    const parent = (await post(h, '', msg('b'))).body.conversation_id;
    const directId = (await post(h, '', { parent_conversation_id: parent, ...msg('c') })).body
      .conversation_id;
    await post(h, `/${parent}/close`, {});
    const direct = await get(h, `/${directId}/events`);
    expect(direct.body.status).toBe('closed');
    const parentEvents = (await get(h, `/${parent}/events`)).body.events as PoppyEvent[];
    expect(parentEvents.slice(-2).map((e) => e.type)).toEqual(['direct_closed', 'state']);
  });

  it('in a Direct Conversation, an authorization event is also asked in a message', async () => {
    const agent = await agentFor((_a, turn) =>
      turn === 0 ? { text: '', toolCall: { name: 'list_orders', input: {} } } : { text: '' },
    );
    agent.registry.register(
      {
        name: 'list_orders',
        kind: 'read',
        description: 'x',
        inputSchema: z.object({}),
        roles: ['scope:poppy:read'],
      },
      { execute: async () => ({}) },
    );
    const h = await served({
      service: agent.service,
      toolRoles: (name) => agent.registry.spec(name)?.roles,
    });
    const parent = (await post(h, '', { message: { id: 'msg_d0', sender: 'agent', context: {} } }))
      .body.conversation_id;
    const directId = (
      await post(h, '', {
        parent_conversation_id: parent,
        message: { id: 'msg_d1', sender: 'human', text: 'my orders?' },
      })
    ).body.conversation_id;
    const { events } = await readUntil(h, directId, (e) =>
      e.some((x) => x.type === 'authorization'),
    );
    await readUntil(h, directId, settled);
    const all = (await get(h, `/${directId}/events`)).body.events as PoppyEvent[];
    expect(events.find((e) => e.type === 'authorization')).toMatchObject({
      error: 'sign_in_required',
    });
    expect(companyMessages(all).at(-1)?.message.text).toMatch(/sign in/);
  });
});

// ── durability ───────────────────────────────────────────────────────────────

describe('Poppy durability', () => {
  it('another replica writes the reply of a turn whose writer died — once', async () => {
    const agent = await agentFor(() => ({ text: 'recovered reply' }));
    const store = new InMemoryPoppyStore();
    const actor = { id: 'poppy:x', roles: [PERSONAL_AGENT_ROLE] };
    const { runId, threadId } = await agent.service.chat({
      actor,
      message: 'hi',
      transient: true,
    });
    const now = Date.now();
    await store.createConversation({
      id: 'cnv_orphan',
      clientId: CLIENT,
      userId: 'u1',
      accountRef: null,
      agentName: '',
      threadId,
      parentId: null,
      openDirectId: null,
      status: 'working',
      responder: 'agent',
      context: {},
      activeRunId: runId,
      turnSeq: 1,
      grant: { actor, scopes: [], signedIn: false },
      prunedSeq: 0,
      createdAt: now,
      updatedAt: now,
    });
    const h = await served({ service: agent.service, toolRoles: () => undefined, store });
    const { events } = await readUntil(h, 'cnv_orphan', settled);
    expect(companyMessages(events).map((e) => e.message.text)).toEqual(['recovered reply']);
    await sleep(100);
    const again = await get(h, '/cnv_orphan/events');
    expect(companyMessages(again.body.events)).toHaveLength(1);
  });
});

describe('publicOrigin', () => {
  it('prefers baseUrl; else the request, upgraded to https behind a TLS proxy of an https issuer', () => {
    const request = { protocol: 'http', host: 'api.acme.com' };
    expect(publicOrigin(request, 'https://acme.com/')).toBe('https://acme.com');
    expect(publicOrigin(request, undefined, 'https://auth.acme.com')).toBe('https://api.acme.com');
    expect(publicOrigin(request, undefined, undefined)).toBe('http://api.acme.com');
  });
});
