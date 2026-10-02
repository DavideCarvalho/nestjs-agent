import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai';
import { expect, it } from 'vitest';
import { AgentChatTransport } from './agent-chat-transport.js';
it('turns a safe text decision into truthful assistant text without starting or resuming a run', async () => {
  const decision = {
    threadId: 'thread',
    proposalDecision: { status: 'ambiguous', proposalIds: ['one', 'two'] },
    text: 'Which proposal should I approve?',
  };
  const transport = new AgentChatTransport({
    fetch: async () =>
      new Response(JSON.stringify(decision), { headers: { 'content-type': 'application/json' } }),
  });
  const args: Parameters<ChatTransport<UIMessage>['sendMessages']>[0] = {
    trigger: 'submit-message',
    chatId: 'thread',
    messageId: undefined,
    messages: [{ id: 'user', role: 'user', parts: [{ type: 'text', text: 'confirm' }] }],
    abortSignal: undefined,
  };
  const stream = await transport.sendMessages(args);
  const chunks: UIMessageChunk[] = [];
  const reader = stream.getReader();
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    chunks.push(result.value);
  }
  expect(chunks).toContainEqual({
    type: 'data-proposal-decision',
    data: decision,
    transient: true,
  });
  expect(chunks).toContainEqual({ type: 'text-delta', id: 'decision', delta: decision.text });
  expect(transport.runId).toBeUndefined();
  expect(transport.threadId).toBe('thread');
  expect(transport.isAttemptLive).toBe(false);
});
