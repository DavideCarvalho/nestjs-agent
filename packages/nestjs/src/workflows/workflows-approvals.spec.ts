import { FakeModelProvider, type FakeScript } from '@dudousxd/nestjs-agent-testing';
import { Injectable } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Agent } from '../decorator/agent.decorator.js';
import { AiTool } from '../decorator/ai-tool.decorator.js';
import { buildWorkflowsApp, collect } from './workflows-app.spec-helper.js';

const executed: string[] = [];

@AiTool({
  name: 'purgeCache',
  kind: 'action',
  description: 'purge',
  input: z.object({ key: z.string() }),
})
@Injectable()
class PurgeCacheTool {
  async execute(input: { key: string }) {
    executed.push(input.key);
    return { purged: input.key };
  }
}

@Agent({ name: 'default', systemPrompt: 'workflows approvals agent', model: 'fake-1' })
@Injectable()
class DefaultAgent {}

const ADMIN = { id: 'u1', roles: ['ADMIN'] };

/** The first step purges, the next one answers. */
const purgeOnce: FakeScript = (args) =>
  args.messages.at(-1)?.role === 'user'
    ? { text: 'about to purge', toolCall: { name: 'purgeCache', input: { key: 'cfg' } } }
    : { text: 'finished' };

function app() {
  return buildWorkflowsApp({
    model: new FakeModelProvider(purgeOnce),
    providers: [PurgeCacheTool, DefaultAgent],
  });
}

describe('approvals on @nestjs/workflows', () => {
  it('runs a turn with no tool to completion', async () => {
    const node = await buildWorkflowsApp({
      model: new FakeModelProvider(() => ({ text: 'hello there' })),
      providers: [DefaultAgent],
    });
    try {
      const { runId } = await node.service.chat({ actor: ADMIN, message: 'hi' });
      const streamed = collect(node.service.subscribe(runId));
      await node.drain();
      expect((await node.client.getStatus(runId))?.status).toBe('completed');
      expect(await streamed).toContain('hello there');
      expect(await node.runner.isRunActive(runId)).toBe(false);
    } finally {
      await node.close();
    }
  });

  it('parks the action on a person, lists it as pending, and runs it once approved', async () => {
    executed.length = 0;
    const node = await app();
    try {
      const { runId } = await node.service.chat({ actor: ADMIN, message: 'purge it' });
      const streamed = collect(node.service.subscribe(runId));
      await node.drain();

      const row = node.agentStore.toolCallRows()[0];
      expect(row?.status).toBe('pending_approval');
      const callId = row?.toolCallId ?? '';
      const status = await node.client.getStatus(runId);
      expect(status?.status).toBe('suspended');
      expect(status?.waits).toEqual([{ signal: 'aviary.agent.reply', key: `${runId}:${callId}` }]);
      expect(await node.runner.pendingReplies(runId)).toEqual([
        {
          key: `${runId}:${callId}`,
          runId,
          toolCallId: callId,
          toolName: 'purgeCache',
          kind: 'approval',
        },
      ]);
      expect(await node.runner.isRunActive(runId)).toBe(true);
      expect(executed).toEqual([]);

      await node.service.approve(ADMIN, callId);
      await node.drain();

      expect((await node.client.getStatus(runId))?.status).toBe('completed');
      expect(await node.runner.pendingReplies(runId)).toEqual([]);
      expect(executed).toEqual(['cfg']);
      expect(node.agentStore.toolCallRows()[0]?.status).toBe('executed');
      const frames = await streamed;
      expect(frames).toContain('finished');
      // One model call per step, each a journaled step, and the tool call its own step.
      const journal = (await node.client.getStatus(runId, { journal: true }))?.journal ?? [];
      const names = journal.map((entry) => entry.name);
      expect(names).toContain('llm:0');
      expect(names).toContain('llm:1');
      expect(names).toContain(`tool:${callId}`);
      expect(names).toContain(`reply:${callId}`);
    } finally {
      await node.close();
    }
  });

  it('tells the model when the person denies, and never runs the tool', async () => {
    executed.length = 0;
    const node = await app();
    try {
      const { runId } = await node.service.chat({ actor: ADMIN, message: 'purge it' });
      await node.drain();
      const callId = node.agentStore.toolCallRows()[0]?.toolCallId ?? '';
      await node.service.reject(ADMIN, callId, 'not today');
      await node.drain();
      expect((await node.client.getStatus(runId))?.status).toBe('completed');
      expect(executed).toEqual([]);
      expect(node.agentStore.toolCallRows()[0]?.status).toBe('rejected');
    } finally {
      await node.close();
    }
  });

  it('expires a request nobody decides once its time to live passes on the clock', async () => {
    executed.length = 0;
    const node = await buildWorkflowsApp({
      model: new FakeModelProvider(purgeOnce),
      providers: [PurgeCacheTool, DefaultAgent],
      approvalPolicy: {
        requirementFor: () => ({ required: true, approver: 'requester', ttlMs: 60_000 }),
      },
    });
    try {
      const { runId } = await node.service.chat({ actor: ADMIN, message: 'purge it' });
      await node.drain();
      expect(node.agentStore.toolCallRows()[0]?.status).toBe('pending_approval');
      node.clock.advance('2m');
      await node.drain();
      expect((await node.client.getStatus(runId))?.status).toBe('completed');
      expect(node.agentStore.toolCallRows()[0]?.status).toBe('expired');
      expect(executed).toEqual([]);
    } finally {
      await node.close();
    }
  });
});
