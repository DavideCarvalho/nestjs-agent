// @vitest-environment node
import 'reflect-metadata';
import {
  AGENT_TOOL_REGISTRY,
  type ApprovalPolicy,
  type ChannelFollower,
  InMemoryAgentStore,
  InMemoryPoppyConnectionStore,
  type ToolRegistry,
} from '@dudousxd/nestjs-agent-core';
import { FakeModelProvider } from '@dudousxd/nestjs-agent-testing';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateEs256Key } from '../client/keys.js';
import { FakeCompany } from '../client/testing/fake-company.spec-helper.js';
import {
  type App,
  SECRET,
  capture,
  connectLink,
  ctx,
  direct,
  owner,
  preflight,
  required,
  setup,
  tool,
  until,
} from './connections.spec-helper.js';
import { Sealer } from './crypto.js';
import { continueAfterConnect } from './resume.js';
import { PoppyConnections } from './service.js';
import { callCompanyTool, registerPoppyConnectionTools } from './tools.js';

vi.setConfig({ testTimeout: 20_000 });

let app: App | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

function fakeOf(a: App | null): FakeCompany {
  return required(a, 'app').fake;
}

describe('poppy-connections: identity', () => {
  it('serves its client metadata and public keys under {path}', async () => {
    app = await setup();
    const meta = (await (await fetch(`${app.base}/poppy-agent/agent.json`)).json()) as {
      logo_uri: string;
    };
    expect(meta).toMatchObject({
      client_id: `${app.base}/poppy-agent/agent.json`,
      client_name: 'Acme Assistant',
      jwks_uri: `${app.base}/poppy-agent/jwks.json`,
      redirect_uris: [`${app.base}/poppy-agent/oauth/callback`],
      token_endpoint_auth_method: 'private_key_jwt',
    });
    // The default logo_uri resolves (a consent screen shows it).
    expect(meta.logo_uri).toBe(`${app.base}/poppy-agent/logo.svg`);
    const logo = await fetch(meta.logo_uri);
    expect(logo.status).toBe(200);
    // Express adds the charset of the string it sends.
    expect(logo.headers.get('content-type')).toMatch(/^image\/svg\+xml\b/);
    expect(await logo.text()).toContain('>A</text>');
    const jwks = (await (await fetch(`${app.base}/poppy-agent/jwks.json`)).json()) as {
      keys: unknown[];
    };
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]).not.toHaveProperty('d');
  });

  it('insecureDev is refused in production; the module refuses a short secret', () => {
    expect(
      () =>
        new PoppyConnections({
          config: { baseUrl: 'http://x', identity: { name: 'x', keys: [] }, insecureDev: true },
          store: new InMemoryPoppyConnectionStore(),
          secret: SECRET,
          production: true,
        }),
    ).toThrow(/development only/);
  });

  it('a short secret stops the module from booting', async () => {
    await expect(
      setup({ connections: { secret: 'short' } }).then(async (a) => {
        await a.close();
      }),
    ).rejects.toThrow(/at least 32 characters/);
  });

  it('api routes: 404 without `api`, 401 for nobody, the list and a disconnect', async () => {
    let who: typeof owner | null = null;
    app = await setup({ connections: { api: { actor: () => who } } });
    const server = app.nest.getHttpServer();
    await request(server).get('/poppy-agent/api/connections').expect(401);
    who = owner;
    expect((await request(server).get('/poppy-agent/api/connections').expect(200)).body).toEqual({
      connections: [],
    });
    await direct(await connectLink(app));
    const listed = await request(server).get('/poppy-agent/api/connections').expect(200);
    expect(listed.body.connections).toMatchObject([
      { domain: app.fake.domain, organization: 'Fake Co', status: 'active' },
    ]);
    const removed = await request(server)
      .delete(`/poppy-agent/api/connections/${encodeURIComponent(app.fake.domain)}`)
      .expect(200);
    expect(removed.body).toEqual({ disconnected: true });
    const refused = await request(server)
      .delete('/poppy-agent/api/connections/other.example')
      .expect(400);
    expect(refused.body).toMatchObject({ error: 'not_allowed' });
  });

  it('without `api` its routes are not there', async () => {
    app = await setup();
    await request(app.nest.getHttpServer()).get('/poppy-agent/api/connections').expect(404);
  });
});

describe('poppy-connections: allow-list', () => {
  it('denies every company by default, and anything off the list', async () => {
    app = await setup({ connections: { companies: [] } });
    expect(app.connections.policy(app.fake.domain)).toBeNull();
    expect(await tool(app, 'companies', {})).toEqual({ companies: [] });
    // Each refusal points the model back to the list (a guessed domain is a common slip).
    expect(await preflight(app, 'connect', { company: app.fake.domain })).toMatchObject({
      status: 'denied',
      reason: expect.stringContaining('Call poppy_companies'),
    });
    expect(await tool(app, 'read', { company: app.fake.domain, tool: 'whoami' })).toMatchObject({
      error: 'not_allowed',
      next: expect.stringContaining('poppy_companies'),
    });
    expect(app.fake.log.length + app.fake.sessions.size).toBe(0); // nothing was fetched
  });

  it('a company named rather than by domain resolves to the one allowed company', async () => {
    app = await setup();
    const domain = app.fake.domain;
    // Before connecting, the name its poppy.json gives ("Fake Co") already names it.
    expect(await app.connections.resolveCompany('account-1', 'fakeco.com')).toBe(domain);
    expect(await preflight(app, 'connect', { company: 'Fake Co' })).toMatchObject({
      status: 'ready',
    });
    await direct(await connectLink(app));
    // Connected: its organization names it, as a word or a guessed domain.
    for (const name of ['Fake Co', 'fakeco.com', 'FAKECO']) {
      const listed = (await tool(app, 'tools', { company: name })) as { tools?: unknown[] };
      expect(listed.tools, name).toBeDefined();
    }
    expect(await tool(app, 'tools', { company: 'other.example' })).toMatchObject({
      error: 'not_allowed',
    });
    expect(await app.connections.resolveCompany('account-1', 'Fake Co')).toBe(domain);
  });

  it('a label names an allowed company before any connection', async () => {
    const fake = await new FakeCompany().start();
    const domain = fake.domain;
    await fake.stop();
    const connections = new PoppyConnections({
      config: {
        baseUrl: 'http://127.0.0.1:1',
        identity: {
          name: 'X',
          keys: [(await generateEs256Key()).privateJwk as Record<string, unknown>],
        },
        companies: { [domain]: { label: 'Acme Shop' }, 'b.example': { label: 'Acme' } },
        insecureDev: true,
      },
      store: new InMemoryPoppyConnectionStore(),
      secret: SECRET,
      production: false,
    });
    expect(await connections.resolveCompany('o', 'acmeshop.com')).toBe(domain);
    expect(await connections.resolveCompany('o', 'Acme')).toBe('b.example');
    expect(await connections.resolveCompany('o', 'nope.example')).toBe('nope.example');
  });

  it('lists the allowed ones with their connection', async () => {
    app = await setup();
    expect(await tool(app, 'companies', {})).toEqual({
      // Named as its poppy.json names it, before any connection.
      companies: [
        { company: app.fake.domain, organization: 'Fake Co', connected: false, scopes: [] },
      ],
    });
  });
});

describe('poppy-connections: connect flows', () => {
  it('Direct: the card carries the link, the callback connects it', async () => {
    app = await setup();
    const link = await connectLink(app);
    expect(await (await fetch(link)).text()).toContain('/direct');
    expect(await direct(link)).toContain('Connected to Fake Co');

    expect(await app.store.getPending(app.connections.connectIdFor('run-1:call-1'))).toMatchObject({
      status: 'connected',
      toolCallId: 'call-1',
      runId: 'run-1',
      threadId: 'thread-1',
    });
    expect(await tool(app, 'connect', { company: app.fake.domain })).toMatchObject({
      connected: true,
    });
    const [row] = await app.store.listConnections('account-1');
    expect(row).toMatchObject({
      status: 'active',
      organization: 'Fake Co',
      domain: app.fake.domain,
    });
    // Sealed at rest: no Account Token in clear.
    const token = required([...app.fake.accountTokens.keys()][0]);
    expect(required(row).state).not.toContain(token);
    expect(
      new Sealer(SECRET).open<{ accountToken: { refreshToken: string } }>(required(row).state)
        .accountToken.refreshToken,
    ).toBe(token);
    // Already connected: no new card.
    expect(await preflight(app, 'connect', { company: app.fake.domain }, 'call-2')).toMatchObject({
      status: 'completed',
    });
    // The link is single-purpose: done is done.
    expect(await (await fetch(link)).text()).toContain('Connected to Fake Co');
  });

  it('the same call reaches the same link (a replay does not mint another)', async () => {
    app = await setup();
    expect(await connectLink(app)).toBe(await connectLink(app));
    expect(await connectLink(app, {}, 'call-9')).not.toBe(await connectLink(app));
  });

  it('Mediated: credentials and the code go through this app’s page, never stored', async () => {
    app = await setup();
    const link = await connectLink(app);
    const page = await (await fetch(link)).text();
    expect(page).toContain('type="password"');
    const step = await fetch(`${link}/mediated`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: 'dana@example.com', password: 'hunter2' }).toString(),
    });
    expect(await step.text()).toContain('ending in 71');
    const done = await fetch(`${link}/code`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'code=123456',
    });
    expect(await done.text()).toContain('Connected to Fake Co');
    const [row] = await app.store.listConnections('account-1');
    expect(required(row).scope).toBe('poppy:read');
    const pending = await app.store.getPending(app.connections.connectIdFor('run-1:call-1'));
    expect(JSON.stringify(pending)).not.toContain('hunter2');
    expect(required(row).state).not.toContain('hunter2');
  });

  it('Device: a code to approve at the company, then "I approved it"', async () => {
    app = await setup({ fake: { devicePendingPolls: 1 } });
    const link = await connectLink(app);
    const page = await (await fetch(`${link}/device`, { method: 'POST' })).text();
    expect(page).toContain('WDJB-MJHT');
    expect(await (await fetch(`${link}/device/check`, { method: 'POST' })).text()).toContain(
      'Not approved yet',
    );
    expect(await (await fetch(`${link}/device/check`, { method: 'POST' })).text()).toContain(
      'Not approved yet',
    );
    expect(await (await fetch(`${link}/device/check`, { method: 'POST' })).text()).toContain(
      'Connected to Fake Co',
    );
    expect(await app.store.getPending(app.connections.connectIdFor('run-1:call-1'))).toMatchObject({
      status: 'connected',
    });
  });

  it('an unknown or expired link says so', async () => {
    app = await setup({ connections: { connectTtlSeconds: 1 } });
    expect((await fetch(`${app.base}/poppy-agent/connect/${'a'.repeat(32)}`)).status).toBe(410);
    const link = await connectLink(app);
    await new Promise((r) => setTimeout(r, 1100));
    expect((await fetch(link)).status).toBe(410);
  });
});

describe('poppy-connections: tools at the company', () => {
  it('reads run at once; a write is an action with a confirmation; scope step-up', async () => {
    app = await setup();
    const kinds = Object.fromEntries([...app.tools].map(([name, t]) => [name, t.spec.kind]));
    expect(kinds).toMatchObject({
      poppy_read: 'read',
      poppy_write: 'action',
      poppy_request: 'action',
      poppy_connect: 'action',
    });
    // The card lives as long as its link.
    expect(app.tools.get('poppy_connect')?.spec.approvalTtlMs).toBe(15 * 60_000);

    // Not connected: the write is refused before any card.
    expect(
      await preflight(app, 'write', { company: app.fake.domain, tool: 'place_order' }),
    ).toMatchObject({ status: 'denied' });

    // Mediated grants only poppy:read (a form post the app's body parser does not read).
    const link = await connectLink(app);
    await fetch(`${link}/mediated`, {
      method: 'POST',
      body: 'email=dana%40example.com&password=hunter2',
    });
    await fetch(`${link}/code`, { method: 'POST', body: 'code=123456' });

    const listed = (await tool(app, 'tools', { company: app.fake.domain })) as {
      tools: { name: string; readOnly: boolean }[];
    };
    expect(listed.tools.map((t) => [t.name, t.readOnly])).toEqual([
      ['whoami', true],
      ['search_products', true],
      ['place_order', false],
      ['book_trip', false],
    ]);
    expect(
      await tool(app, 'read', {
        company: app.fake.domain,
        tool: 'search_products',
        arguments: { query: 'boots' },
      }),
    ).toMatchObject({ result: expect.stringContaining('insulated boots') });
    expect(
      await tool(app, 'read', {
        company: app.fake.domain,
        tool: 'place_order',
        arguments: { sku: 'x' },
      }),
    ).toMatchObject({ error: 'not_read_only' });
    const card = await preflight(app, 'write', {
      company: app.fake.domain,
      tool: 'place_order',
      arguments: { sku: 'x' },
    });
    expect(card).toMatchObject({
      status: 'ready',
      confirmation: {
        title: 'Fake Co: place_order',
        detail: expect.stringContaining('"sku": "x"'),
      },
    });
    // Approved, but the connection lacks poppy:write → a step-up, not a failure.
    expect(
      await tool(app, 'write', {
        company: app.fake.domain,
        tool: 'place_order',
        arguments: { sku: 'x' },
      }),
    ).toMatchObject({ error: 'needs_permission', scopes: ['poppy:write'] });
    // Step up through connect (Direct grants poppy:write), then the write runs.
    const more = await connectLink(app, { scopes: ['poppy:write'] }, 'call-2');
    await direct(more);
    expect(
      await tool(app, 'write', {
        company: app.fake.domain,
        tool: 'place_order',
        arguments: { sku: 'x' },
      }),
    ).toMatchObject({ result: 'ordered x' });
  });

  it('a two-step company write: the card shows its preview, confirming commits with the token', async () => {
    app = await setup();
    await direct(await connectLink(app));
    const input = { company: app.fake.domain, tool: 'book_trip', arguments: { city: 'Lisbon' } };
    // The card carries the company's own preview; nothing is booked yet.
    expect(await preflight(app, 'write', input)).toMatchObject({
      status: 'ready',
      confirmation: { detail: expect.stringContaining('Preview: book a trip to Lisbon.') },
    });
    expect(app.fake.trips).toEqual([]);
    // Confirmed: one write call previews and commits — the trip is booked once.
    expect(await tool(app, 'write', input)).toMatchObject({
      result: expect.stringContaining('"booked"'),
    });
    expect(app.fake.trips).toEqual(['Lisbon']);
    // A tool without the convention runs once, as is.
    expect(
      await tool(app, 'write', {
        company: app.fake.domain,
        tool: 'place_order',
        arguments: { sku: 'y' },
      }),
    ).toMatchObject({ result: 'ordered y' });
  });

  it('twoStep: false leaves a two-step tool to the model (only the preview runs)', async () => {
    app = await setup({ connections: { tools: { twoStep: false } } });
    await direct(await connectLink(app));
    const out = (await tool(app, 'write', {
      company: app.fake.domain,
      tool: 'book_trip',
      arguments: { city: 'Porto' },
    })) as { result: string };
    expect(JSON.parse(out.result)).toMatchObject({ status: 'preview' });
    expect(app.fake.trips).toEqual([]);
  });

  it('ask narrows the token to the read scopes; request uses the grant', async () => {
    app = await setup();
    // Not connected: the company asks for a sign-in → the tool says connect.
    expect(
      await tool(app, 'ask', { company: app.fake.domain, message: 'show my orders' }),
    ).toMatchObject({ error: 'not_connected' });
    await direct(await connectLink(app));
    const asked = (await tool(app, 'ask', {
      company: app.fake.domain,
      message: 'show my orders',
    })) as Record<string, unknown>;
    expect(asked.reply).toContain('Here are your orders.');
    const used = [...app.fake.tokens.values()].filter((t) => t.signedIn && !t.bearer);
    expect(used.some((t) => t.scope === 'poppy:read')).toBe(true);
    const requested = (await tool(app, 'request', {
      company: app.fake.domain,
      message: 'hello',
    })) as Record<string, unknown>;
    expect(requested.reply).toContain('You said: hello');
    expect(
      await preflight(app, 'request', { company: app.fake.domain, message: 'cancel ord_1042' }),
    ).toMatchObject({
      status: 'ready',
      confirmation: { title: 'Ask Fake Co to act', detail: 'cancel ord_1042' },
    });
  });

  it('the module registers the tools in the agent registry, with their prefix and roles', async () => {
    app = await setup({ connections: { tools: { prefix: 'co_', roles: ['member'] } } });
    const registry = app.nest.get<symbol, ToolRegistry>(AGENT_TOOL_REGISTRY);
    expect(registry.spec('co_connect')).toMatchObject({ kind: 'action', roles: ['member'] });
    expect(registry.has('poppy_connect')).toBe(false);
  });
});

describe('poppy-connections: revocation and refresh', () => {
  it('disconnect revokes the Account Token at the company; later calls say not connected', async () => {
    app = await setup();
    await direct(await connectLink(app));
    expect(await preflight(app, 'disconnect', { company: app.fake.domain })).toMatchObject({
      status: 'ready',
    });
    expect(await tool(app, 'disconnect', { company: app.fake.domain })).toMatchObject({
      disconnected: true,
    });
    expect([...app.fake.accountTokens.values()].every((t) => t.revoked)).toBe(true);
    expect((await app.store.listConnections('account-1'))[0]).toMatchObject({
      status: 'revoked',
      scope: '',
    });
    expect(
      await tool(app, 'ask', { company: app.fake.domain, message: 'show my orders' }),
    ).toMatchObject({ error: 'not_connected' });
    expect(await preflight(app, 'disconnect', { company: app.fake.domain })).toMatchObject({
      status: 'completed',
    });
    // However the company words its refusal (a bare 401 here), not connected means: connect.
    app.fake.bareMcpErrors = true;
    expect(await tool(app, 'tools', { company: app.fake.domain })).toMatchObject({
      error: 'not_connected',
    });
    expect(await tool(app, 'read', { company: app.fake.domain, tool: 'whoami' })).toMatchObject({
      error: 'not_connected',
    });
  });

  it('a revocation at the company is noticed (invalid_grant) and the connection marked revoked', async () => {
    app = await setup({ fake: { accessTtl: 1 } });
    await direct(await connectLink(app));
    for (const t of app.fake.accountTokens.values()) t.revoked = true;
    await new Promise((r) => setTimeout(r, 1100));
    expect(
      await tool(app, 'ask', { company: app.fake.domain, message: 'show my orders' }),
    ).toMatchObject({ error: 'not_connected' });
    expect((await app.store.listConnections('account-1'))[0]).toMatchObject({ status: 'revoked' });
  });

  it('revoked at the company while a signed-in MCP token is still valid: noticed, marked revoked', async () => {
    app = await setup();
    await direct(await connectLink(app));
    expect(await tool(app, 'read', { company: app.fake.domain, tool: 'whoami' })).toMatchObject({
      result: expect.stringContaining('"signed_in":true'),
    });
    app.fake.revokeAtCompany();
    // The cached Bearer is still valid but its Session is signed out: the Account Token is tried,
    // answers invalid_grant, and the call goes on signed out (a public tool still answers)…
    expect(
      await tool(app, 'read', {
        company: app.fake.domain,
        tool: 'search_products',
        arguments: { query: 'boots' },
      }),
    ).toMatchObject({ result: expect.stringContaining('boots') });
    // …while the connection is marked revoked: the model sees it is no longer connected.
    expect((await app.store.listConnections('account-1'))[0]).toMatchObject({ status: 'revoked' });
    expect(await tool(app, 'companies', {})).toMatchObject({
      companies: [{ company: app.fake.domain, connected: false }],
    });
  });

  it('expired Session Tokens renew with the Account Token, a rotated one is kept sealed', async () => {
    app = await setup({ fake: { accessTtl: 1, rotateAccountToken: true } });
    await direct(await connectLink(app));
    const first = [...app.fake.accountTokens.keys()];
    await new Promise((r) => setTimeout(r, 1100));
    expect(await tool(app, 'read', { company: app.fake.domain, tool: 'whoami' })).toMatchObject({
      result: expect.stringContaining('"signed_in":true'),
    });
    const current = [...app.fake.accountTokens.entries()]
      .filter(([, t]) => !t.revoked)
      .map(([k]) => k);
    expect(current.some((k) => !first.includes(k))).toBe(true);
    const [row] = await app.store.listConnections('account-1');
    expect(
      new Sealer(SECRET).open<{ accountToken: { refreshToken: string } }>(required(row).state)
        .accountToken.refreshToken,
    ).toBe(current[0]);
  });

  it('two owners never share a connection', async () => {
    app = await setup();
    await direct(await connectLink(app));
    const other = ctx('call-1', { id: 'profile-2', tenantRef: 'account-2' });
    expect(
      await required(app.tools.get('poppy_ask')).handler.execute(
        { company: app.fake.domain, message: 'show my orders' },
        other,
      ),
    ).toMatchObject({ error: 'not_connected' });
  });
});

/** The model: connect first; once the call's result is in, say what came back. */
function connectThenReport() {
  return new FakeModelProvider((args, turn) => {
    if (turn === 0)
      return {
        text: '',
        toolCall: { name: 'poppy_connect', input: { company: fakeOf(app).domain } },
      };
    return { text: `after connect: ${JSON.stringify(args.messages.at(-1)?.toolResults ?? '')}` };
  });
}

/** The model of an independent turn: connect; wait; once told it is connected, go on. */
function connectThenContinue(seen: string[], reply: string) {
  return new FakeModelProvider((args) => {
    const users = args.messages.filter((m) => m.role === 'user');
    const last = String(users.at(-1)?.content ?? '');
    seen.push(last);
    if (last.includes('I connected my account at Fake Co')) return { text: reply };
    if (args.messages.some((m) => (m.toolResults?.length ?? 0) > 0))
      return { text: 'Waiting for the sign-in.' };
    return {
      text: '',
      toolCall: { name: 'poppy_connect', input: { company: fakeOf(app).domain } },
    };
  });
}

describe('poppy-connections: the connect card resumes the turn (blocking approvals)', () => {
  it('the sign-in approves the parked connect call; the turn continues connected', async () => {
    const agentStore = new InMemoryAgentStore();
    app = await setup({ agent: { model: connectThenReport() }, agentStore });
    const { runId } = await app.service.chat({ actor: owner, message: 'order boots at Fake Co' });
    await until('parked', () =>
      agentStore
        .toolCallRows()
        .some((r) => r.toolName === 'poppy_connect' && r.status === 'pending_approval'),
    );
    const parked = required(agentStore.toolCallRows().find((r) => r.toolName === 'poppy_connect'));
    const link = app.connections.connectUrl(
      app.connections.connectIdFor(`${runId}:${parked.toolCallId}`),
    );
    expect(await direct(link)).toContain('Connected to Fake Co');
    await until(
      'executed',
      () =>
        agentStore.toolCallRows().find((r) => r.toolName === 'poppy_connect')?.status ===
        'executed',
    );
    const row = required(agentStore.toolCallRows().find((r) => r.toolName === 'poppy_connect'));
    expect(row.decidedVia).toBe('poppy-connect');
    expect(JSON.stringify(row.output)).toContain('"connected":true');
  });
});

describe('poppy-connections: independent approvals continue the turn', () => {
  it('the sign-in decides the connect proposal; once its outcome is in, the model goes on', async () => {
    const seen: string[] = [];
    const followed: unknown[] = [];
    const follower: ChannelFollower = {
      follow: async (address, run) => {
        followed.push({ address, run });
        return true;
      },
    };
    const agentStore = new InMemoryAgentStore();
    app = await setup({
      agent: {
        model: connectThenContinue(seen, 'Connected — ordering the boots now.'),
        actionApprovalMode: 'independent',
      },
      agentStore,
      follower,
    });
    const service = app.service;
    const { runId, threadId } = await service.chat({
      actor: owner,
      message: 'order boots at Fake Co',
      pageContext: { channel: { name: 'whatsapp', conversation: '5511@s' } },
    });
    await until(
      'proposed',
      async () => (await service.listActionProposals(owner, threadId)).length > 0,
    );
    await until('first turn done', () => seen.some((t) => t === 'order boots at Fake Co'));
    const proposal = required((await service.listActionProposals(owner, threadId))[0]);
    const link = app.connections.connectUrl(
      app.connections.connectIdFor(`${runId}:${proposal.originToolCallId}`),
    );
    expect(await direct(link)).toContain('Connected to Fake Co');
    // The connect ran, its outcome was written, and a new turn went on with the request.
    await until('continued', () =>
      seen.some((t) => t.includes('I connected my account at Fake Co')),
    );
    await until('answered', async () =>
      ((await agentStore.getThread(threadId))?.messages ?? []).some((m) =>
        String(m.content).includes('ordering the boots now'),
      ),
    );
    const after = required((await service.listActionProposals(owner, threadId))[0]);
    expect(after).toMatchObject({ decision: 'approved', outcomeDelivery: { status: 'admitted' } });
    expect(JSON.stringify(after.outcome?.result)).toContain('"connected":true');
    // The channel the turn came from gets the new run.
    expect(followed).toMatchObject([
      { address: { name: 'whatsapp', conversation: '5511@s' }, run: { threadId } },
    ]);
    // Only once: the outcome is admitted once.
    await new Promise((r) => setTimeout(r, 200));
    expect(seen.filter((t) => t.includes('I connected my account')).length).toBe(1);
  });

  it('the card lives as long as its link (not the 5-min policy); a sign-in after it expired still goes on', async () => {
    let offset = 0;
    const agentStore = new InMemoryAgentStore({ clock: () => Date.now() + offset });
    const seen: string[] = [];
    const followed: unknown[] = [];
    // Every other action's card lapses in 5 minutes.
    const approvalPolicy: ApprovalPolicy = {
      requirementFor: (tool) => ({
        required: tool.kind === 'action',
        approver: 'requester',
        ttlMs: 5 * 60_000,
      }),
    };
    app = await setup({
      agent: {
        model: connectThenContinue(seen, 'Going on.'),
        actionApprovalMode: 'independent',
        approvalPolicy,
      },
      agentStore,
      follower: {
        follow: async (address, run) => {
          followed.push({ address, run });
          return true;
        },
      },
    });
    const service = app.service;
    const { runId, threadId } = await service.chat({
      actor: owner,
      message: 'order boots at Fake Co',
      pageContext: { channel: { name: 'whatsapp', conversation: '5511@s' } },
    });
    await until(
      'proposed',
      async () => (await service.listActionProposals(owner, threadId)).length > 0,
    );
    const proposal = required((await service.listActionProposals(owner, threadId))[0]);
    // The connect card's own lifetime (the link's, 15 min), not the policy's 5 min.
    const lifetime = required(proposal.expiresAt) - proposal.createdAt;
    expect(lifetime).toBeGreaterThan(15 * 60_000 - 5_000);
    expect(lifetime).toBeLessThanOrEqual(15 * 60_000);
    await until('first turn done', () => seen.includes('order boots at Fake Co'));
    // The person comes back after it lapsed; the link (the page) still works a little longer.
    offset = 16 * 60_000;
    const link = app.connections.connectUrl(
      app.connections.connectIdFor(`${runId}:${proposal.originToolCallId}`),
    );
    expect(await direct(link)).toContain('Connected to Fake Co');
    // Stored, and the conversation goes on instead of nothing happening.
    expect((await app.store.listConnections('account-1'))[0]).toMatchObject({ status: 'active' });
    await until('continued', () =>
      seen.some((t) => t.includes('I connected my account at Fake Co')),
    );
    expect((await service.listActionProposals(owner, threadId))[0]).toMatchObject({
      decision: 'expired',
    });
    await until('followed', () => followed.length > 0);
    expect(followed).toMatchObject([
      { address: { name: 'whatsapp', conversation: '5511@s' }, run: { threadId } },
    ]);
  });

  it('nothing continues for a connect that was not completed (the person tapped the card first)', async () => {
    app = await setup();
    const send = vi.fn();
    const out = await continueAfterConnect({ service: { send } as never }, app.connections, {
      id: 'o',
      proposalId: 'p',
      outcomeVersion: 1,
      tenantRef: 'account-1',
      actorRef: 'profile-1',
      threadId: 't',
      originRunId: 'r',
      originToolCallId: 'c',
      toolName: 'poppy_connect',
      decision: 'approved',
      executionStatus: 'succeeded',
      result: { connected: false, link: 'x' },
      ui: [],
      createdAt: 1,
    });
    expect(out).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });
});

describe('poppy-connections: for loops that do not park on approvals', () => {
  it("connect: 'link' is a read tool returning the link; writes: false leaves the writes to the app", async () => {
    app = await setup();
    const { tools } = capture();
    registerPoppyConnectionTools(capture(tools), app.connections, {
      connect: 'link',
      writes: false,
      ability: 'companies.use',
    });
    expect([...tools.keys()].sort()).toEqual(
      ['poppy_ask', 'poppy_companies', 'poppy_connect', 'poppy_read', 'poppy_tools'].sort(),
    );
    const connect = required(tools.get('poppy_connect'));
    expect(connect.spec.kind).toBe('read');
    expect([...tools.values()].every((t) => t.spec.ability === 'companies.use')).toBe(true);
    const out = (await connect.handler.execute({ company: app.fake.domain }, ctx())) as {
      connected: boolean;
      link: string;
    };
    expect(out.connected).toBe(false);
    expect(await direct(out.link)).toContain('Connected to Fake Co');
    expect(
      await connect.handler.execute({ company: app.fake.domain }, ctx('call-2')),
    ).toMatchObject({ connected: true });
    expect(
      await callCompanyTool(
        app.connections,
        'account-1',
        { company: app.fake.domain, tool: 'place_order', arguments: { sku: 'y' } },
        false,
      ),
    ).toMatchObject({ result: 'ordered y' });
  });
});
