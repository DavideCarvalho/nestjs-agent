import 'reflect-metadata';
import type { Actor, AgentRunInput } from '@dudousxd/nestjs-agent-core';
import { afterEach, describe, expect, it } from 'vitest';
import { openCode } from './engine.js';
import type { FakeScript } from './testing/fake-opencode.js';
import { type Harness, bootEngine } from './testing/harness.js';
import { LOST_ANSWER_ERROR, addUsage, emptyUsage } from './turn.js';
import { OpenCodeTurns } from './turns.js';

const actor: Actor = { id: 'u1', roles: ['ADMIN'] };
const model = { providerID: 'anthropic', id: 'claude-sonnet' };
const tokens = (input: number, output: number) => ({
  input,
  output,
  reasoning: 0,
  cache: { read: 0, write: 0 },
});

/**
 * The steps of a durable turn, driven by hand: `begin` and `prompt` in the process that dies, then
 * `observe` re-run in one that never followed the session (`drop` is what the restart leaves).
 */
async function prompted(h: Harness, message: string) {
  const turns = h.app.get(OpenCodeTurns);
  const thread = await h.store.createThread({ actor });
  const input: AgentRunInput = { threadId: thread.id, actor, userText: message };
  const runId = `run-${thread.id}`;
  const handle = await turns.begin(runId, input);
  await turns.prompt(runId, input, handle, emptyUsage());
  return { turns, input, runId, handle, threadId: thread.id };
}

async function boot(script: (box: { h?: Harness }) => FakeScript) {
  const box: { h?: Harness } = {};
  const h = await bootEngine({ engine: (host) => openCode({ host }), script: script(box) });
  box.h = h;
  return h;
}

describe('a turn resumed after a restart', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.app.close();
    h = undefined;
  });

  it('recovers the answer and its usage the session gave while nobody listened', async () => {
    h = await boot((box) => async (t) => {
      t.unheard('session.step.started', { model });
      t.unheard('session.text.delta', { delta: 'The report ' });
      t.unheard('session.text.delta', { delta: 'is ready.' });
      t.unheard('session.tool.called', { id: 'call_1', name: 'read', input: { path: 'r.md' } });
      t.unheard('session.tool.success', { id: 'call_1' });
      t.unheard('session.step.ended', { tokens: tokens(100, 20), cost: 0.26 });
      t.unheard('session.execution.succeeded');
      box.h?.fake.goIdle();
    });
    const { turns, input, runId, handle, threadId } = await prompted(h, 'write the report');
    expect(h.fake.callsOf('session.prompt')[0]?.args.metadata).toEqual({ runId });
    turns.drop(runId);

    const milestone = await turns.observe(runId, input, handle, emptyUsage());

    expect(milestone).toMatchObject({
      kind: 'finished',
      outcome: { status: 'succeeded' },
      usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.26 },
    });
    if (milestone.kind !== 'finished') throw new Error('not finished');
    await turns.settle(runId, input, milestone.outcome, 0, milestone.usage);
    const answer = (await h.store.getThread(threadId))?.messages.at(-1);
    expect(answer).toMatchObject({
      role: 'assistant',
      content: 'The report is ready.',
      toolCalls: [{ id: 'call_1', name: 'read', input: { path: 'r.md' } }],
      toolResults: [{ id: 'call_1', output: { ok: true } }],
      usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.26 },
    });
  });

  it('takes nothing twice that was heard before the restart', async () => {
    h = await boot((box) => async (t) => {
      t.emit('session.step.started', { model });
      t.emit('session.text.delta', { delta: 'Sending.' });
      t.emit('session.tool.called', { id: 'call_send', name: 'send', input: { to: 'a@b.c' } });
      t.emit('session.step.ended', { tokens: tokens(50, 10), cost: 0.1 });
      t.emit('permission.asked', { id: 'per_1', action: 'company.send' });
      await t.next('permission.reply');
      // The API restarted after the approval: the rest is said to nobody.
      t.unheard('session.tool.success', { id: 'call_send' });
      t.unheard('session.step.started', { model });
      t.unheard('session.text.delta', { delta: 'Sent.' });
      t.unheard('session.step.ended', { tokens: tokens(70, 5), cost: 0.2 });
      t.unheard('session.execution.succeeded');
      box.h?.fake.goIdle();
    });
    const { turns, input, runId, handle, threadId } = await prompted(h, 'send it');
    const asked = await turns.observe(runId, input, handle, emptyUsage());
    if (asked.kind !== 'ask') throw new Error('not asked');
    expect(asked.progress).toMatchObject({ called: ['call_send'], steps: ['asst_1'] });
    const spent = addUsage(emptyUsage(), asked.usage);
    await turns.reply(runId, input, handle, asked.ask, { approved: true }, spent, asked.progress);
    turns.drop(runId);

    const finished = await turns.observe(runId, input, handle, spent, asked.progress);

    // Only the second step is new: the first one's usage travelled with the ask.
    expect(finished).toMatchObject({
      kind: 'finished',
      outcome: { status: 'succeeded' },
      usage: { inputTokens: 70, outputTokens: 5, costUsd: 0.2 },
    });
    if (finished.kind !== 'finished') throw new Error('not finished');
    const total = addUsage(spent, finished.usage);
    await turns.settle(runId, input, finished.outcome, 0, total);
    const messages = (await h.store.getThread(threadId))?.messages ?? [];
    expect(messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'send it'],
      ['assistant', 'Sending.'],
      ['assistant', 'Sent.'],
    ]);
    // The call was persisted before the restart; its result lands on that message, once.
    expect(messages[1]?.toolCalls?.map((c) => c.id)).toEqual(['call_send', 'per_1']);
    expect(messages[1]?.toolResults?.map((r) => r.id).sort()).toEqual(['call_send', 'per_1']);
    expect(messages[2]?.toolCalls).toBeUndefined();
    expect(messages[2]?.usage).toMatchObject({ inputTokens: 120, outputTokens: 15 });
    expect(messages[2]?.usage?.costUsd).toBeCloseTo(0.3);
  });

  it('joins what it missed with what it heard once it re-attached', async () => {
    h = await boot(() => async (t) => {
      t.unheard('session.step.started', { model });
      t.unheard('session.text.delta', { delta: 'Hello ' });
      // The rebuilt turn is listening by the time it waits on the session.
      await t.next('session.wait');
      t.emit('session.text.delta', { delta: 'world.' });
      t.emit('session.step.ended', { tokens: tokens(10, 2), cost: 0.01 });
      t.succeed();
    });
    const { turns, input, runId, handle, threadId } = await prompted(h, 'greet');
    turns.drop(runId);

    const milestone = await turns.observe(runId, input, handle, emptyUsage());

    expect(milestone).toMatchObject({
      kind: 'finished',
      outcome: { status: 'succeeded' },
      usage: { inputTokens: 10, outputTokens: 2 },
    });
    if (milestone.kind !== 'finished') throw new Error('not finished');
    await turns.settle(runId, input, milestone.outcome, 0, milestone.usage);
    const answer = (await h.store.getThread(threadId))?.messages.at(-1);
    expect(answer?.content).toBe('Hello world.');
  });

  it('fails, rather than answering nothing, when the session left no answer', async () => {
    h = await boot((box) => async (t) => {
      t.unheard('session.execution.succeeded');
      box.h?.fake.goIdle();
    });
    const { turns, input, runId, handle, threadId } = await prompted(h, 'hello?');
    turns.drop(runId);

    const milestone = await turns.observe(runId, input, handle, emptyUsage());

    expect(milestone).toMatchObject({
      kind: 'finished',
      outcome: { status: 'failed', error: LOST_ANSWER_ERROR },
    });
    if (milestone.kind !== 'finished') throw new Error('not finished');
    await turns.settle(runId, input, milestone.outcome, 0, milestone.usage);
    const messages = (await h.store.getThread(threadId))?.messages ?? [];
    expect(messages.filter((m) => m.role === 'assistant' && m.content === '')).toEqual([]);
  });
});
