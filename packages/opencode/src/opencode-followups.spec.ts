import 'reflect-metadata';
import type { Actor } from '@dudousxd/nestjs-agent-core';
import { afterEach, describe, expect, it } from 'vitest';
import { openCode } from './engine.js';
import { keyValueOpenCodeSessionStore } from './host.js';
import type { FakeTurn } from './testing/fake-opencode.js';
import { type Harness, bootEngine, eventually, frames, framesUntil } from './testing/harness.js';
import { OpenCodeTurns } from './turns.js';

const actor: Actor = { id: 'u1', roles: ['ADMIN'] };
const meta = (sessionId: string) => ({ 'ai.opencode/sessionID': sessionId });

/** A script that holds the execution open until the test lets it finish. */
function holdOpen() {
  const gate: { turn?: FakeTurn; release?: () => void } = {};
  const script = async (t: FakeTurn) => {
    gate.turn = t;
    t.emit('session.text.delta', { delta: 'Here is the chart.' });
    await new Promise<void>((resolve) => {
      gate.release = resolve;
    });
    t.succeed();
  };
  return { gate, script };
}

describe('openCode engine: follow-ups', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.app.close();
    h = undefined;
  });

  it("routes a tool's emitUi over MCP into the turn's stream and message", async () => {
    const { gate, script } = holdOpen();
    h = await bootEngine({ engine: (host) => openCode({ host }), script });
    const { runId, threadId } = await h.service.chat({ actor, message: 'chart it' });
    await framesUntil(h.service, runId, (f) => f.kind === 'text');

    const turns = h.app.get(OpenCodeTurns);
    const ctx = await turns.callContext({ actor, serverKey: 'tenant-1', meta: meta('ses_1') });
    expect(ctx).toMatchObject({ runId, ctx: { threadId, runId } });
    await ctx?.ctx.emitUi('Chart', { series: [1, 2] }, { id: 'chart-1' });
    gate.release?.();
    const fs = await frames(h.service, runId);

    expect(fs).toContainEqual({
      kind: 'ui',
      id: 'chart-1',
      component: 'Chart',
      props: { series: [1, 2] },
    });
    const answer = (await h.store.getThread(threadId))?.messages.at(-1);
    expect(answer?.content).toBe('Here is the chart.');
    expect(answer?.ui).toEqual([{ id: 'chart-1', component: 'Chart', props: { series: [1, 2] } }]);
  });

  it('finds the turn of a session this process does not follow, through OpenCode', async () => {
    const { gate, script } = holdOpen();
    h = await bootEngine({ engine: (host) => openCode({ host }), script });
    const { runId, threadId } = await h.service.chat({ actor, message: 'chart it' });
    await framesUntil(h.service, runId, (f) => f.kind === 'text');
    const turns = h.app.get(OpenCodeTurns);
    // As another replica sees it: nothing live here.
    const live = (turns as unknown as { live: Map<string, unknown> }).live;
    const saved = new Map(live);
    live.clear();

    const ctx = await turns.callContext({ actor, serverKey: 'tenant-1', meta: meta('ses_1') });
    expect(ctx).toMatchObject({ runId, ctx: { threadId, runId } });
    await ctx?.ctx.emitUi('Chart', { series: [3] }, { id: 'chart-2' });
    expect(h.fake.callsOf('session.get')[0]?.args).toEqual({ sessionID: 'ses_1' });
    const messages = (await h.store.getThread(threadId))?.messages ?? [];
    expect(messages.at(-1)?.ui).toEqual([
      { id: 'chart-2', component: 'Chart', props: { series: [3] } },
    ]);

    for (const [k, v] of saved) live.set(k, v);
    gate.release?.();
    const fs = await frames(h.service, runId);
    expect(fs).toContainEqual(expect.objectContaining({ kind: 'ui', id: 'chart-2' }));
  });

  it('gives a session to no one but the person whose turn it is', async () => {
    const { gate, script } = holdOpen();
    h = await bootEngine({ engine: (host) => openCode({ host }), script });
    const { runId } = await h.service.chat({ actor, message: 'chart it' });
    await framesUntil(h.service, runId, (f) => f.kind === 'text');
    const turns = h.app.get(OpenCodeTurns);
    const stranger: Actor = { id: 'u2', roles: ['ADMIN'] };
    expect(
      await turns.callContext({ actor: stranger, serverKey: 'tenant-1', meta: meta('ses_1') }),
    ).toBeUndefined();

    // Through OpenCode too (a session this process does not follow).
    const live = (turns as unknown as { live: Map<string, unknown> }).live;
    const saved = new Map(live);
    live.clear();
    expect(
      await turns.callContext({ actor: stranger, serverKey: 'tenant-1', meta: meta('ses_1') }),
    ).toBeUndefined();
    // Only OpenCode's own key names a session.
    expect(
      await turns.callContext({ actor, serverKey: 'tenant-1', meta: { sessionId: 'ses_1' } }),
    ).toBeUndefined();
    // Nor on a server other than the one the token was issued for.
    expect(
      await turns.callContext({ actor, serverKey: 'tenant-2', meta: meta('ses_1') }),
    ).toBeUndefined();
    for (const [k, v] of saved) live.set(k, v);
    gate.release?.();
    await frames(h.service, runId);
  });

  it('keeps the components of two calls apart when neither names an id', async () => {
    const { gate, script } = holdOpen();
    h = await bootEngine({ engine: (host) => openCode({ host }), script });
    const { runId, threadId } = await h.service.chat({ actor, message: 'two charts' });
    await framesUntil(h.service, runId, (f) => f.kind === 'text');
    const turns = h.app.get(OpenCodeTurns);
    const first = await turns.callContext({
      actor,
      serverKey: 'tenant-1',
      requestId: 'mcp:s:1',
      meta: meta('ses_1'),
    });
    const second = await turns.callContext({
      actor,
      serverKey: 'tenant-1',
      requestId: 'mcp:s:2',
      meta: meta('ses_1'),
    });
    await first?.ctx.emitUi('Chart', { n: 1 });
    await second?.ctx.emitUi('Chart', { n: 2 });
    gate.release?.();
    await frames(h.service, runId);
    const ui = (await h.store.getThread(threadId))?.messages.at(-1)?.ui ?? [];
    expect(ui.map((c) => c.props)).toEqual([{ n: 1 }, { n: 2 }]);
    expect(new Set(ui.map((c) => c.id)).size).toBe(2);
  });

  it('claims no call from an unknown session', async () => {
    h = await bootEngine({ engine: (host) => openCode({ host }) });
    const turns = h.app.get(OpenCodeTurns);
    expect(
      await turns.callContext({ actor, serverKey: 'tenant-1', meta: undefined }),
    ).toBeUndefined();
    expect(
      await turns.callContext({ actor, serverKey: 'tenant-1', meta: meta('ses_nope') }),
    ).toBeUndefined();
  });

  it('keeps sessions in a shared key-value store', async () => {
    const kv = new Map<string, string>();
    const store = keyValueOpenCodeSessionStore({
      get: async (k) => kv.get(k) ?? null,
      set: async (k, v) => kv.set(k, v),
    });
    expect(await store.get('t1')).toBeNull();
    await store.set('t1', { sessionId: 'ses_1', serverKey: 'tenant-1', bootId: 'b1' });
    expect(await store.get('t1')).toEqual({
      sessionId: 'ses_1',
      serverKey: 'tenant-1',
      bootId: 'b1',
    });
    expect([...kv.keys()]).toEqual(['aviary:opencode:session:t1']);

    // Two engines sharing it reuse one session per thread.
    const shared = new Map<string, string>();
    const sessions = keyValueOpenCodeSessionStore({
      get: async (k) => shared.get(k) ?? null,
      set: async (k, v) => shared.set(k, v),
    });
    h = await bootEngine({ engine: (host) => openCode({ host, sessions }) });
    const first = await h.service.chat({ actor, message: 'one' });
    await frames(h.service, first.runId);
    await eventually(() => shared.size === 1, 'the session was stored');
    expect(JSON.parse([...shared.values()][0] ?? '{}')).toMatchObject({ sessionId: 'ses_1' });
  });
});

describe('openCode engine: host-side pushes and live runs', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.app.close();
    h = undefined;
  });

  it('pushes into the run a session serves, and reports the runs it follows', async () => {
    const { gate, script } = holdOpen();
    h = await bootEngine({ engine: (host) => openCode({ host }), script });
    const { runId, threadId } = await h.service.chat({ actor, message: 'go' });
    await framesUntil(h.service, runId, (f) => f.kind === 'text');
    const turns = h.app.get(OpenCodeTurns);
    expect(turns.liveRuns()).toEqual([runId]);
    expect(
      await turns.pushToSession('ses_1', {
        id: 'card-1',
        component: 'Artifact',
        props: { id: 'a1' },
      }),
    ).toBe(true);
    expect(await turns.pushToSession('ses_nope', { id: 'x', component: 'X', props: {} })).toBe(
      false,
    );
    gate.release?.();
    await frames(h.service, runId);
    expect((await h.store.getThread(threadId))?.messages.at(-1)?.ui).toEqual([
      { id: 'card-1', component: 'Artifact', props: { id: 'a1' } },
    ]);
    expect(turns.liveRuns()).toEqual([]);
  });

  it("lets an authorized send continue someone else's thread", async () => {
    h = await bootEngine({ engine: (host) => openCode({ host }) });
    const first = await h.service.chat({ actor, message: 'one' });
    await frames(h.service, first.runId);
    const colleague: Actor = { id: 'slack:T1:U2', roles: [] };
    await expect(
      h.service.chat({ actor: colleague, message: 'two', threadId: first.threadId }),
    ).rejects.toThrow();
    const second = await h.service.chat({
      actor: colleague,
      message: 'two',
      threadId: first.threadId,
      authorized: true,
    });
    await frames(h.service, second.runId);
    expect((await h.store.getThread(first.threadId))?.messages.map((m) => m.content)).toEqual([
      'one',
      'echo: one',
      'two',
      'echo: two',
    ]);
  });
});
