import 'reflect-metadata';
import {
  AGENT_TOOL_REGISTRY,
  type Actor,
  type AiToolCtx,
  DefaultRolesPolicy,
  type MemoryProvider,
  type StoreMemoryInput,
  type ToolRegistry,
} from '@dudousxd/nestjs-agent-core';
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
    const ctx = await turns.toolContext({ actor, meta: meta('ses_1') });
    expect(ctx).toMatchObject({ threadId, runId });
    await ctx?.emitUi?.('Chart', { series: [1, 2] }, { id: 'chart-1' });
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

    const ctx = await turns.toolContext({ actor, meta: meta('ses_1') });
    expect(ctx).toMatchObject({ threadId, runId });
    await ctx?.emitUi?.('Chart', { series: [3] }, { id: 'chart-2' });
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

  it('leaves a call from an unknown session standing on its own', async () => {
    h = await bootEngine({ engine: (host) => openCode({ host }) });
    const turns = h.app.get(OpenCodeTurns);
    expect(await turns.toolContext({ actor, meta: undefined })).toBeUndefined();
    expect(await turns.toolContext({ actor, meta: meta('ses_nope') })).toBeUndefined();
  });

  it('serves remember over MCP when memory writes, at the actor scope only', async () => {
    const written: StoreMemoryInput[] = [];
    const provider: MemoryProvider = {
      list: () => [],
      forget: () => false,
      write: (input) => {
        written.push(input);
        return { id: 'm1', ...input, updatedAt: '2026-10-06T00:00:00.000Z' };
      },
    };
    h = await bootEngine({
      engine: (host) => openCode({ host, tools: { url: 'https://app.test/mcp' } }),
      options: { memory: { provider } },
    });
    const registry = h.app.get<ToolRegistry>(AGENT_TOOL_REGISTRY);
    expect(registry.spec('remember')?.kind).toBe('read');

    const { runId, threadId } = await h.service.chat({ actor, message: 'hi' });
    await frames(h.service, runId);
    expect(h.fake.callsOf('session.create')[0]?.args.permissions).toContainEqual({
      action: 'aviary*',
      resource: '*',
      effect: 'allow',
    });

    const ctx = {
      actor,
      threadId,
      runId,
      requestId: 'r1',
      emitUi: async () => ({ id: 'x' }),
    } as AiToolCtx;
    const out = await registry.invoke(
      'remember',
      { key: 'email.tone', fact: 'Prefers short emails' },
      ctx,
      new DefaultRolesPolicy(),
    );
    expect(out).toBe('Recorded "email.tone".');
    expect(written).toEqual([
      expect.objectContaining({
        key: 'email.tone',
        text: 'Prefers short emails',
        scope: 'actor:u1',
        origin: { author: 'agent', actorRef: 'u1', threadId, runId },
      }),
    ]);
    const tooLong = await registry.invoke(
      'remember',
      { key: 'k', fact: 'x'.repeat(500) },
      ctx,
      new DefaultRolesPolicy(),
    );
    expect(String(tooLong)).toContain('at most');
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
