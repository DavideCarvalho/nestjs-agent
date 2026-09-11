import type { AgentRunner, HumanReply } from '@dudousxd/nestjs-agent-core';
import { InMemoryAgentStore } from '@dudousxd/nestjs-agent-testing';
import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { AgentDepsFactory } from '../agent-deps.factory.js';
import { AgentService } from '../agent.service.js';

const OWNER = { id: 'u1', roles: ['ADMIN'] };
const STRANGER = { id: 'u2', roles: ['ADMIN'] };

interface Delivered {
  runId: string;
  toolCallId: string;
  reply: HumanReply;
}

function serviceWith(store: InMemoryAgentStore): { service: AgentService; sent: Delivered[] } {
  const sent: Delivered[] = [];
  const runner: AgentRunner = {
    start: async () => ({ runId: 'unused' }),
    signal: async (runId, toolCallId, reply) => {
      sent.push({ runId, toolCallId, reply });
    },
    cancel: async () => {},
  };
  const service = new AgentService(runner, store, {} as unknown as AgentDepsFactory, undefined);
  return { service, sent };
}

/** A thread with one parked question set, recorded against `runId`. */
async function parkedQuestion(runId: string, toolCallId: string) {
  const store = new InMemoryAgentStore();
  const thread = await store.createThread({ actor: OWNER });
  const message = await store.appendMessage({
    threadId: thread.id,
    role: 'assistant',
    content: 'a few questions',
    runId,
  });
  await store.recordToolCall({
    toolCallId,
    messageId: message.id,
    toolName: 'ask',
    toolType: 'action',
    input: { questions: [] },
    status: 'pending_approval',
    runId,
  });
  return { store, threadId: thread.id };
}

describe('answering a parked question set', () => {
  it('delivers the answers to the run that asked, gated by the same ownership check as approve', async () => {
    const { store } = await parkedQuestion('run-a', 'call-1');
    const { service, sent } = serviceWith(store);

    await service.answer(OWNER, 'call-1', { scope: ['file'] });

    expect(sent).toEqual([
      {
        runId: 'run-a',
        toolCallId: 'call-1',
        reply: { answers: { scope: ['file'] }, answeredByRef: 'u1' },
      },
    ]);
  });

  it('refuses an answer from someone who does not own the thread', async () => {
    const { store } = await parkedQuestion('run-a', 'call-1');
    const { service, sent } = serviceWith(store);

    await expect(service.answer(STRANGER, 'call-1', {})).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.skip(STRANGER, 'call-1')).rejects.toBeInstanceOf(ForbiddenException);
    expect(sent).toEqual([]);
  });

  it('sends a skip as its own reply, never as an empty answer', async () => {
    const { store } = await parkedQuestion('run-a', 'call-1');
    const { service, sent } = serviceWith(store);

    await service.skip(OWNER, 'call-1');

    expect(sent[0]?.reply).toEqual({ answers: {}, skipped: true, answeredByRef: 'u1' });
  });

  it('accepts a submission that carries nothing, so confirming really is enough', async () => {
    const { store } = await parkedQuestion('run-a', 'call-1');
    const { service, sent } = serviceWith(store);

    await service.answer(OWNER, 'call-1');

    expect(sent[0]?.reply).toEqual({ answers: {}, answeredByRef: 'u1' });
  });
});

describe('routing a human reply when a thread holds more than one live run', () => {
  it('reaches the run that recorded the call, not whichever run is streaming the thread', async () => {
    const { store, threadId } = await parkedQuestion('run-a', 'call-1');
    // A second run on the same thread takes over the live stream while the first is still parked —
    // the shape a detached sub-run puts a thread in. Keying off `activeStreamId` would post the
    // answer into `run-b`, which is waiting on nothing.
    await store.setActiveStream(threadId, 'run-b');
    const { service, sent } = serviceWith(store);

    await service.answer(OWNER, 'call-1', {});

    expect(sent[0]?.runId).toBe('run-a');
  });

  it('falls back to the thread’s active stream for a row written before calls carried a runId', async () => {
    const store = new InMemoryAgentStore();
    const thread = await store.createThread({ actor: OWNER });
    const message = await store.appendMessage({
      threadId: thread.id,
      role: 'assistant',
      content: 'do it?',
    });
    await store.recordToolCall({
      toolCallId: 'legacy',
      messageId: message.id,
      toolName: 'purgeCache',
      toolType: 'action',
      input: {},
      status: 'pending_approval',
    });
    await store.setActiveStream(thread.id, 'run-b');
    const { service, sent } = serviceWith(store);

    await service.approve(OWNER, 'legacy');

    expect(sent[0]?.runId).toBe('run-b');
  });
});
