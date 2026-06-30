// Integration: MikroOrmAgentStore + ensureAgentSchema against an in-memory SQLite
// (better-sqlite3, via @mikro-orm/sqlite). Runs only under `pnpm test:db`.
import type { StoredMessage, ThreadSummary } from '@dudousxd/nestjs-agent-core';
import { MikroORM, SqliteDriver } from '@mikro-orm/sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureAgentSchema } from './ensure-schema';
import { agentEntities } from './entities';
import { AgentToolCall } from './entities/agent-tool-call.entity';
import { MikroOrmAgentStore } from './mikro-orm-agent-store';

let orm: MikroORM;
let store: MikroOrmAgentStore;

beforeAll(async () => {
  orm = await MikroORM.init({
    driver: SqliteDriver,
    dbName: ':memory:',
    // No collation: SQLite rejects named MySQL collations. Production uses AGENT_ENTITIES.
    entities: agentEntities(),
    allowGlobalContext: true,
  });
  await ensureAgentSchema(orm);
  store = new MikroOrmAgentStore(orm.em);
});

afterAll(async () => {
  await orm?.close(true);
});

describe('MikroOrmAgentStore (sqlite)', () => {
  it('persists threads, messages, tool calls, usage and honours fork/truncate/soft-delete', async () => {
    const today = new Date().toISOString().slice(0, 10);

    // createThread
    const thread = await store.createThread({
      actor: { id: 'actor-1' },
      persona: 'default',
      title: 'My chat',
    });
    expect(thread.id).toBeTruthy();
    expect(thread.title).toBe('My chat');
    expect(thread.persona).toBe('default');
    expect(thread.transient).toBe(false);

    // appendMessage (user)
    const userMessage = await store.appendMessage({
      threadId: thread.id,
      role: 'user',
      content: 'Hello',
    });
    expect(userMessage.role).toBe('user');
    expect(userMessage.content).toBe('Hello');

    // appendMessage (assistant with tool calls + usage)
    const assistantMessage = await store.appendMessage({
      threadId: thread.id,
      role: 'assistant',
      content: 'Looking that up',
      toolCalls: [{ id: 'tc-1', name: 'lookup', input: { q: 'weather' } }],
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    expect(assistantMessage.toolCalls).toEqual([
      { id: 'tc-1', name: 'lookup', input: { q: 'weather' } },
    ]);
    expect(assistantMessage.usage).toEqual({ inputTokens: 10, outputTokens: 5 });

    // recordToolCall (pending) → updateToolCall (executed)
    await store.recordToolCall({
      toolCallId: 'tc-1',
      messageId: assistantMessage.id,
      toolName: 'lookup',
      toolType: 'read',
      input: { q: 'weather' },
      status: 'pending_approval',
    });
    await store.updateToolCall({
      toolCallId: 'tc-1',
      status: 'executed',
      output: { result: 'sunny' },
      executionMs: 12,
      executedByRef: 'worker-1',
    });

    const toolCall = await orm.em.fork().findOne(AgentToolCall, { id: 'tc-1' });
    expect(toolCall?.status).toBe('executed');
    expect(toolCall?.output).toEqual({ result: 'sunny' });
    expect(toolCall?.executionMs).toBe(12);
    expect(toolCall?.executedByRef).toBe('worker-1');
    expect(toolCall?.executedAt).toBeInstanceOf(Date);

    // getThread → both messages in order, with tool-call data preserved
    const detail = await store.getThread(thread.id);
    expect(detail).not.toBeNull();
    const messages = detail?.messages as StoredMessage[];
    expect(messages).toHaveLength(2);
    expect(messages[0]?.content).toBe('Hello');
    expect(messages[1]?.content).toBe('Looking that up');
    expect(messages[1]?.toolCalls?.[0]?.id).toBe('tc-1');
    expect(messages[1]?.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(detail?.lastMessagePreview).toBe('Looking that up');

    // recordUsage twice → quotaToday sums them
    await store.recordUsage({
      threadId: thread.id,
      actorRef: 'actor-1',
      modelId: 'model-x',
      purpose: 'chat',
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    await store.recordUsage({
      threadId: thread.id,
      actorRef: 'actor-1',
      modelId: 'model-x',
      purpose: 'chat',
      usage: { inputTokens: 20, outputTokens: 7 },
    });
    const quota = await store.quotaToday('actor-1', today);
    expect(quota.usedTokens).toBe(42);
    const otherQuota = await store.quotaToday('actor-2', today);
    expect(otherQuota.usedTokens).toBe(0);

    // forkThread copies the prefix up to and including the user message
    const fork = await store.forkThread(thread.id, userMessage.id);
    expect(fork.id).not.toBe(thread.id);
    const forkDetail = await store.getThread(fork.id);
    expect(forkDetail?.messages).toHaveLength(1);
    expect(forkDetail?.messages[0]?.content).toBe('Hello');

    // truncateFrom drops the assistant message and onward
    await store.truncateFrom(thread.id, assistantMessage.id);
    const truncated = await store.getThread(thread.id);
    expect(truncated?.messages).toHaveLength(1);
    expect(truncated?.messages[0]?.content).toBe('Hello');
    // tool call attached to the dropped message is gone
    expect(await orm.em.fork().findOne(AgentToolCall, { id: 'tc-1' })).toBeNull();

    // listThreads sees both threads before soft delete
    const before: ThreadSummary[] = await store.listThreads('actor-1');
    expect(before.map((t) => t.id).sort()).toEqual([thread.id, fork.id].sort());

    // softDeleteThread → getThread null + excluded from listThreads
    await store.softDeleteThread(thread.id);
    expect(await store.getThread(thread.id)).toBeNull();
    const after = await store.listThreads('actor-1');
    expect(after.map((t) => t.id)).toEqual([fork.id]);
  });
});
