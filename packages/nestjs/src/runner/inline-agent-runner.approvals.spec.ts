import {
  type AgentStore,
  DefaultRolesPolicy,
  type RecordRunEndInput,
  ToolRegistry,
} from '@dudousxd/nestjs-agent-core';
import { FakeModelProvider, InMemoryAgentStore } from '@dudousxd/nestjs-agent-testing';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AgentDepsFactory } from '../agent-deps.factory.js';
import type { AgentDeps } from '../agent-deps.js';
import { InProcessTokenStreamSink } from '../in-process-sink.js';
import { InlineAgentRunner } from './inline-agent-runner.js';

const ACTOR = { id: 'u1', roles: ['ADMIN'] };

async function harness(ttlMs: number) {
  const inner = new InMemoryAgentStore();
  let settle!: (end: RecordRunEndInput) => void;
  const settled = new Promise<RecordRunEndInput>((resolve) => {
    settle = resolve;
  });
  const store: AgentStore = Object.assign(Object.create(inner) as InMemoryAgentStore, {
    recordRunEnd: async (end: RecordRunEndInput) => {
      settle(end);
      await inner.recordRunEnd(end);
    },
  });
  const registry = new ToolRegistry();
  registry.register(
    { name: 'purge', kind: 'action', description: 'purge', inputSchema: z.object({}) },
    { execute: async () => ({ purged: true }) },
  );
  const deps: AgentDeps = {
    model: new FakeModelProvider((_args, turnIndex) =>
      turnIndex === 0
        ? { text: 'purging', toolCall: { name: 'purge', input: {} } }
        : { text: 'ok' },
    ),
    store,
    registry,
    rolesPolicy: new DefaultRolesPolicy(),
    approvalPolicy: { requirementFor: () => ({ required: true, approver: 'requester', ttlMs }) },
    sink: new InProcessTokenStreamSink(),
    modelId: 'fake-1',
    systemPrompt: 'test',
    promptContributors: [],
    maxSteps: 8,
    inputProcessors: [],
    outputProcessors: [],
  };
  const factory = { forAgent: () => deps } as unknown as AgentDepsFactory;
  const runner = new InlineAgentRunner(factory, store);
  const threadId = (await inner.createThread({ actor: ACTOR })).id;
  return { runner, store: inner, threadId, settled };
}

describe('the inline runner’s approval expiry', () => {
  it('settles the call expired when nobody decides within the time to live', async () => {
    const h = await harness(30);
    await h.runner.start({ threadId: h.threadId, actor: ACTOR, userText: 'purge' });
    const end = await h.settled;
    expect(end.status).toBe('completed');
    expect(h.store.toolCallRows()[0]).toMatchObject({ status: 'expired' });
  });

  it('lets a decision that arrives in time win, and disarms the timer', async () => {
    const h = await harness(5_000);
    const { runId } = await h.runner.start({
      threadId: h.threadId,
      actor: ACTOR,
      userText: 'purge',
    });
    for (let attempt = 0; h.store.toolCallRows()[0]?.status !== 'pending_approval'; attempt += 1) {
      if (attempt > 200) {
        throw new Error('never parked');
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const callId = h.store.toolCallRows()[0]?.toolCallId ?? '';
    await h.runner.signal(runId, callId, { approved: true, decidedVia: 'web' });
    await h.settled;
    expect(h.store.toolCallRows()[0]).toMatchObject({ status: 'executed', decidedVia: 'web' });
  });
});
