import 'reflect-metadata';
import { Agent, AiTool } from '@dudousxd/nestjs-agent';
import {
  AGENT_TOOL_REGISTRY,
  type Actor,
  type ApprovalPolicy,
  type MemoryProvider,
  type StoreMemoryInput,
  type ToolRegistry,
} from '@dudousxd/nestjs-agent-core';
import { Injectable } from '@nestjs/common';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { openCode } from './engine.js';
import { OpenCodeToolsTokens } from './mcp.js';
import type { FakeTurn } from './testing/fake-opencode.js';
import { type Harness, bootEngine, eventually, frames, framesUntil } from './testing/harness.js';
import { OpenCodeTurns } from './turns.js';

const actor: Actor = { id: 'u1', roles: ['ADMIN'] };
const stranger: Actor = { id: 'u2', roles: ['ADMIN'] };
const SECRET = 'test-secret';
const ENDPOINT = '/agent/opencode/mcp';
const meta = (sessionId: string) => ({ 'ai.opencode/sessionID': sessionId });

const sent: unknown[] = [];

@AiTool({ name: 'lookup', kind: 'read', description: 'look something up', input: z.object({}) })
@Injectable()
class LookupTool {
  async execute() {
    return { found: true };
  }
}

@AiTool({
  name: 'send',
  kind: 'action',
  description: 'send it',
  input: z.object({ to: z.string() }),
})
@Injectable()
class SendTool {
  async execute(input: { to: string }) {
    sent.push(input);
    return { sent: true };
  }
}

@Agent({ name: 'default', systemPrompt: 'Help.' })
@Injectable()
class DefaultAgent {}

@Agent({ name: 'narrow', systemPrompt: 'Look things up only.', tools: ['lookup'] })
@Injectable()
class NarrowAgent {}

/**
 * A turn that asks for `send` (as OpenCode does for an `ask` rule), then stays open until the test
 * lets it finish — so MCP calls land while the turn runs.
 */
function askThenHold() {
  const gate: { turn?: FakeTurn; release?: () => void } = {};
  const script = async (t: FakeTurn) => {
    gate.turn = t;
    t.emit('session.text.delta', { delta: 'Working.' });
    if (!t.text.includes('no-ask')) {
      t.emit('permission.asked', { id: 'per_1', action: 'aviary_send' });
      await t.next('permission.reply');
    }
    await new Promise<void>((resolve) => {
      gate.release = resolve;
    });
    t.succeed();
  };
  return { gate, script };
}

async function boot(
  script: (t: FakeTurn) => Promise<void>,
  extra: { memory?: MemoryProvider; approvalPolicy?: ApprovalPolicy } = {},
) {
  sent.length = 0;
  return bootEngine({
    engine: (host) =>
      openCode({ host, tools: { url: 'https://app.test/agent/opencode/mcp', secret: SECRET } }),
    script,
    providers: [LookupTool, SendTool, DefaultAgent, NarrowAgent],
    options: {
      ...(extra.memory !== undefined ? { memory: { provider: extra.memory } } : {}),
      ...(extra.approvalPolicy !== undefined ? { approvalPolicy: extra.approvalPolicy } : {}),
    },
  });
}

/** The bearer token the engine registered the session's tools endpoint with. */
function registeredAuth(h: Harness): string {
  const config = h.fake.callsOf('mcp.add').at(-1)?.args.config as {
    headers: Record<string, string>;
  };
  return config.headers.Authorization as string;
}

let rpcId = 0;
async function rpc(
  h: Harness,
  auth: string | undefined,
  method: string,
  params: Record<string, unknown> = {},
) {
  const req = request(h.app.getHttpServer())
    .post(ENDPOINT)
    .set('accept', 'application/json, text/event-stream')
    .set('content-type', 'application/json');
  if (auth !== undefined) req.set('authorization', auth);
  return req.send({ jsonrpc: '2.0', id: ++rpcId, method, params });
}

async function callTool(
  h: Harness,
  auth: string,
  name: string,
  args: Record<string, unknown>,
  session = 'ses_1',
) {
  const res = await rpc(h, auth, 'tools/call', {
    name,
    arguments: args,
    _meta: meta(session),
  });
  expect(res.status).toBe(200);
  return res.body.result as { content: Array<{ text: string }>; isError?: boolean };
}

describe('openCode engine: the tools endpoint', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.app.close();
    h = undefined;
  });

  it('registers the endpoint with a signed, expiring token for the actor and the server', async () => {
    const { gate, script } = askThenHold();
    h = await boot(script);
    const { runId } = await h.service.chat({ actor, message: 'no-ask' });
    await framesUntil(h.service, runId, (f) => f.kind === 'text');
    expect(h.fake.callsOf('mcp.add')[0]?.args).toMatchObject({
      server: 'aviary',
      config: { type: 'remote', url: 'https://app.test/agent/opencode/mcp', oauth: false },
    });
    const token = registeredAuth(h).replace(/^Bearer /, '');
    const claims = new OpenCodeToolsTokens(SECRET, 1000).verify(token);
    expect(claims).toMatchObject({ v: 1, actor: { id: 'u1' }, server: 'tenant-1' });
    expect(claims?.exp).toBeGreaterThan(Date.now());
    // Another secret, a tampered body, or a lapsed token: not ours.
    expect(new OpenCodeToolsTokens('other', 1000).verify(token)).toBeNull();
    expect(new OpenCodeToolsTokens(SECRET, 1000).verify(`x${token}`)).toBeNull();
    expect(new OpenCodeToolsTokens(SECRET, 1000).verify(token, Date.now() + 8 * 864e5)).toBeNull();
    gate.release?.();
    await frames(h.service, runId);
  });

  it('answers 401 without a valid token, and 405 to GET', async () => {
    h = await boot(askThenHold().script);
    expect((await rpc(h, undefined, 'tools/list')).status).toBe(401);
    expect((await rpc(h, 'Bearer nope', 'tools/list')).status).toBe(401);
    const lapsed = new OpenCodeToolsTokens(SECRET, -1).mint(actor, 'tenant-1');
    expect((await rpc(h, `Bearer ${lapsed}`, 'tools/list')).status).toBe(401);
    const forged = new OpenCodeToolsTokens('guessed', 60_000).mint(actor, 'tenant-1');
    expect((await rpc(h, `Bearer ${forged}`, 'tools/list')).status).toBe(401);
    expect((await request(h.app.getHttpServer()).get(ENDPOINT)).status).toBe(405);
  });

  it('refuses a direct action call nobody approved', async () => {
    const { gate, script } = askThenHold();
    h = await boot(script);
    // The turn is running, and its approval card is waiting: nothing is approved yet.
    const { runId } = await h.service.chat({ actor, message: 'send it' });
    await framesUntil(h.service, runId, (f) => f.kind === 'approval-requested');
    const auth = registeredAuth(h);

    // What a model in code mode could do with the headers it read off OpenCode's config.
    const result = await callTool(h, auth, 'send', { to: 'boss@acme.test' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('nobody approved this call');
    expect(sent).toEqual([]);

    await h.service.reject(actor, 'per_1');
    // A rejection grants nothing either.
    expect((await callTool(h, auth, 'send', { to: 'boss@acme.test' })).isError).toBe(true);
    expect(sent).toEqual([]);
    gate.release?.();
    await frames(h.service, runId);
  });

  it('runs an action once per approval granted in the turn', async () => {
    const { gate, script } = askThenHold();
    h = await boot(script);
    const { runId } = await h.service.chat({ actor, message: 'send it' });
    await framesUntil(h.service, runId, (f) => f.kind === 'approval-requested');
    await h.service.approve(actor, 'per_1');
    await eventually(() => h?.fake.callsOf('permission.reply').length === 1, 'OpenCode was told');
    const auth = registeredAuth(h);

    const first = await callTool(h, auth, 'send', { to: 'boss@acme.test' });
    expect(first.isError).toBeFalsy();
    expect(JSON.parse(first.content[0]?.text ?? '{}')).toEqual({ sent: true });
    expect(sent).toEqual([{ to: 'boss@acme.test' }]);

    // The same approval again: spent.
    const second = await callTool(h, auth, 'send', { to: 'everyone@acme.test' });
    expect(second.isError).toBe(true);
    expect(second.content[0]?.text).toContain('nobody approved this call');
    expect(sent).toHaveLength(1);
    gate.release?.();
    await frames(h.service, runId);

    // The run is over: nothing of it can be spent any more.
    const after = await callTool(h, auth, 'send', { to: 'boss@acme.test' });
    expect(after.isError).toBe(true);
    expect(after.content[0]?.text).toContain('no turn of yours is running');
  });

  it('spends an approval the policy granted on its own, once', async () => {
    const { gate, script } = askThenHold();
    h = await boot(script, {
      approvalPolicy: { requirementFor: () => ({ required: false, approver: 'requester' }) },
    });
    const { runId } = await h.service.chat({ actor, message: 'send it' });
    await eventually(() => h?.fake.callsOf('permission.reply').length === 1, 'policy answered');
    const auth = registeredAuth(h);
    expect((await callTool(h, auth, 'send', { to: 'a@acme.test' })).isError).toBeFalsy();
    expect((await callTool(h, auth, 'send', { to: 'b@acme.test' })).isError).toBe(true);
    expect(sent).toEqual([{ to: 'a@acme.test' }]);
    gate.release?.();
    await frames(h.service, runId);
  });

  it('serves no call outside a turn of the caller running on the calling session', async () => {
    const { gate, script } = askThenHold();
    h = await boot(script);
    const tokens = new OpenCodeToolsTokens(SECRET, 60_000);
    // No turn at all yet.
    const idle = await callTool(h, `Bearer ${tokens.mint(actor, 'tenant-1')}`, 'lookup', {});
    expect(idle.isError).toBe(true);
    expect(idle.content[0]?.text).toContain('no turn of yours is running');

    const { runId } = await h.service.chat({ actor, message: 'no-ask' });
    await framesUntil(h.service, runId, (f) => f.kind === 'text');
    const auth = registeredAuth(h);
    expect((await callTool(h, auth, 'lookup', {})).isError).toBeFalsy();
    // No session named, or another one.
    const bare = await rpc(h, auth, 'tools/call', { name: 'lookup', arguments: {} });
    expect(bare.body.result.isError).toBe(true);
    expect((await callTool(h, auth, 'lookup', {}, 'ses_other')).isError).toBe(true);
    // Somebody else's token on this person's session, or this person's for another server.
    const theirs = `Bearer ${tokens.mint(stranger, 'tenant-1')}`;
    expect((await callTool(h, theirs, 'lookup', {})).isError).toBe(true);
    const elsewhere = `Bearer ${tokens.mint(actor, 'tenant-2')}`;
    expect((await callTool(h, elsewhere, 'lookup', {})).isError).toBe(true);
    gate.release?.();
    await frames(h.service, runId);
  });

  it("applies the agent's allow-list on the list and on the call", async () => {
    const { gate, script } = askThenHold();
    h = await boot(script);
    const { runId } = await h.service.chat({ actor, message: 'no-ask', agentName: 'narrow' });
    await framesUntil(h.service, runId, (f) => f.kind === 'text');
    const auth = registeredAuth(h);
    const listed = await rpc(h, auth, 'tools/list', { _meta: meta('ses_1') });
    expect(listed.body.result.tools.map((t: { name: string }) => t.name)).toEqual(['lookup']);
    const refused = await callTool(h, auth, 'send', { to: 'x@acme.test' });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]?.text).toMatch(/send/);
    expect(sent).toEqual([]);
    // And OpenCode is told to deny it.
    expect(h.fake.callsOf('session.create')[0]?.args.permissions).toContainEqual({
      action: 'aviary_send',
      resource: '*',
      effect: 'deny',
    });
    gate.release?.();
    await frames(h.service, runId);
  });

  it('serves remember on its own surface only, writing at the actor scope', async () => {
    const written: StoreMemoryInput[] = [];
    const memory: MemoryProvider = {
      list: () => [],
      forget: () => false,
      write: (input) => {
        written.push(input);
        return { id: 'm1', ...input, updatedAt: '2026-10-06T00:00:00.000Z' };
      },
    };
    const { gate, script } = askThenHold();
    h = await boot(script, { memory });
    // Not in the module's shared registry: not on `AgentMcpServerModule`, not in `/tools`.
    const registry = h.app.get<ToolRegistry>(AGENT_TOOL_REGISTRY);
    expect(registry.has('remember')).toBe(false);
    const catalog = await request(h.app.getHttpServer())
      .get('/agent/tools')
      .set('x-actor-id', 'u1')
      .set('x-actor-roles', 'ADMIN');
    expect(JSON.stringify(catalog.body)).not.toContain('remember');

    const { runId, threadId } = await h.service.chat({ actor, message: 'no-ask' });
    await framesUntil(h.service, runId, (f) => f.kind === 'text');
    const auth = registeredAuth(h);
    const listed = await rpc(h, auth, 'tools/list', { _meta: meta('ses_1') });
    expect(listed.body.result.tools.map((t: { name: string }) => t.name)).toContain('remember');

    const out = await callTool(h, auth, 'remember', { key: 'email.tone', fact: 'Short emails' });
    expect(out.content[0]?.text).toBe('Recorded "email.tone".');
    expect(written).toEqual([
      expect.objectContaining({
        key: 'email.tone',
        text: 'Short emails',
        scope: 'actor:u1',
        origin: { author: 'agent', actorRef: 'u1', threadId, runId },
      }),
    ]);
    const tooLong = await callTool(h, auth, 'remember', { key: 'k', fact: 'x'.repeat(5000) });
    expect(tooLong.content[0]?.text).toContain('at most');
    gate.release?.();
    await frames(h.service, runId);
  });

  it("routes a tool's emitUi into the turn's stream through the endpoint", async () => {
    const { gate, script } = askThenHold();
    h = await boot(script);
    const { runId } = await h.service.chat({ actor, message: 'no-ask' });
    await framesUntil(h.service, runId, (f) => f.kind === 'text');
    const turns = h.app.get(OpenCodeTurns);
    const call = await turns.callContext({ actor, serverKey: 'tenant-1', meta: meta('ses_1') });
    await call?.ctx.emitUi('Chart', { n: 1 }, { id: 'c1' });
    gate.release?.();
    const fs = await frames(h.service, runId);
    expect(fs).toContainEqual({ kind: 'ui', id: 'c1', component: 'Chart', props: { n: 1 } });
  });
});
