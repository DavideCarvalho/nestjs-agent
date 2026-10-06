import type { AgentRunInput } from '@dudousxd/nestjs-agent-core';
import { InMemoryAgentStore } from '@dudousxd/nestjs-agent-testing';
import { Logger } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { FakeOpenCode } from './testing/fake-opencode.js';
import { OpenCodeTurn } from './turn.js';

describe('OpenCodeTurn', () => {
  it('lands the decision on the message that carries a request recovered after a restart', async () => {
    const store = new InMemoryAgentStore();
    const thread = await store.createThread({ actor: { id: 'u1', roles: [] } });
    const input: AgentRunInput = {
      threadId: thread.id,
      actor: { id: 'u1', roles: [] },
      userText: 'send',
    };
    // What the process that died left behind: the message with the call, and the call's row.
    const message = await store.appendMessage({
      threadId: thread.id,
      role: 'assistant',
      content: 'Sending.',
      runId: 'run-1',
      toolCalls: [{ id: 'per_1', name: 'company.send', input: {}, kind: 'action' }],
    });
    await store.recordToolCall({
      toolCallId: 'per_1',
      messageId: message.id,
      toolName: 'company.send',
      toolType: 'action',
      input: {},
      status: 'pending_approval',
      runId: 'run-1',
      approver: 'requester',
    });
    const fake = new FakeOpenCode();
    fake.openPermissions.set('per_1', { id: 'per_1', sessionID: 'ses_1', action: 'company.send' });
    const frames: Uint8Array[] = [];
    const turn = new OpenCodeTurn({
      runId: 'run-1',
      input,
      client: fake,
      sessionId: 'ses_1',
      writer: { write: (c) => void frames.push(c), end: () => undefined, fail: () => undefined },
      store,
      approvalFor: async () => ({ required: true, approver: 'requester' }),
      modelLabel: 'opencode',
      logger: new Logger('test'),
    });

    await turn.catchUp();
    const milestone = await turn.next();
    expect(milestone).toMatchObject({ kind: 'ask', ask: { id: 'per_1', messageId: message.id } });
    // Recovered, not asked again: no second card on the stream.
    expect(frames).toHaveLength(0);

    if (milestone.kind !== 'ask') throw new Error('expected an ask');
    await turn.decide(milestone.ask, { approved: true });
    const stored = (await store.getThread(thread.id))?.messages.find((m) => m.id === message.id);
    expect(stored?.toolResults).toEqual([
      { id: 'per_1', name: 'company.send', output: { approved: true } },
    ]);
    expect(fake.callsOf('permission.reply')[0]?.args).toMatchObject({ decision: 'once' });
  });
});
