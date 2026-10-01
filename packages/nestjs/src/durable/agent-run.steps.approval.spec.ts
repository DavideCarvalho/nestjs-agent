import { DefaultRolesPolicy, ToolRegistry, createFrameBuffer } from '@dudousxd/nestjs-agent-core';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AgentDepsFactory } from '../agent-deps.factory.js';
import { AgentRunSteps } from './agent-run.steps.js';
import type { DispatchedToolInput } from './agent-run.steps.js';

function stepsFor(execute: () => Promise<unknown>, toolAllowList?: string[]): AgentRunSteps {
  const registry = new ToolRegistry();
  registry.register(
    { name: 'purgeCache', kind: 'action', description: 'purge', inputSchema: z.object({}) },
    { execute },
  );
  const factory = {
    forAgent: () => ({ registry, rolesPolicy: new DefaultRolesPolicy(), toolAllowList }),
  } as unknown as AgentDepsFactory;
  return new AgentRunSteps(factory);
}

function envelope(toolType: 'read' | 'action'): DispatchedToolInput {
  return {
    toolName: 'purgeCache',
    input: {},
    toolCallId: 'call-1',
    toolType,
    transientRetry: false,
    ctx: {
      actor: { id: 'u1', roles: ['ADMIN'] },
      threadId: 't1',
      runId: 'run-1',
      requestId: 'run-1',
    },
  } as DispatchedToolInput;
}

describe('AgentRunSteps.tool — approval gate at the execution site', () => {
  it('refuses an action tool dispatched as an auto-executed read', async () => {
    const execute = vi.fn(async () => ({ purged: true }));
    await expect(stepsFor(execute).tool(envelope('read'))).rejects.toThrow(
      /action tool but was dispatched without approval/,
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('runs the same tool when the dispatch carries its action kind', async () => {
    const execute = vi.fn(async () => ({ purged: true }));
    await expect(stepsFor(execute).tool(envelope('action'))).resolves.toEqual({ purged: true });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

it('overwrites provider supplied preflight with the worker validated preparation', async () => {
  const registry = new ToolRegistry();
  const preflight = vi.fn(() => ({ status: 'denied' as const, reason: 'locked' }));
  registry.register(
    {
      name: 'purgeCache',
      kind: 'action',
      description: 'purge',
      inputSchema: z.object({ key: z.string().transform((value) => value.toUpperCase()) }),
    },
    { preflight, execute: async () => 'changed' },
  );
  const model = {
    runTurn: async () => ({
      text: '',
      toolCalls: [
        {
          id: 'c1',
          name: 'purgeCache',
          input: { key: 'x' },
          preflight: { status: 'completed', output: 'spoof' },
        },
      ],
      usage: { inputTokens: 1, outputTokens: 1 },
    }),
  };
  const factory = {
    forAgent: () => ({
      registry,
      rolesPolicy: new DefaultRolesPolicy(),
      model,
      sink: { open: async () => createFrameBuffer().writer },
    }),
  } as unknown as AgentDepsFactory;
  const result = await new AgentRunSteps(factory).llm({
    actor: { id: 'u1' },
    system: '',
    messages: [],
    runId: 'run1',
    step: 0,
    sinkRunId: 'run1',
    childSink: false,
    threadId: 't1',
  });
  expect(result.toolCalls[0]?.preflight).toEqual({ status: 'denied', reason: 'locked' });
  expect(preflight).toHaveBeenCalledWith(
    { key: 'X' },
    expect.objectContaining({ toolCallId: 'c1', idempotencyKey: 'run1:c1' }),
    { phase: 'prepare' },
  );
});

it('intersects the current worker agent allow-list with the approved envelope before execution', async () => {
  const execute = vi.fn(async () => 'changed');
  const input = { ...envelope('action'), allowedTools: ['purgeCache'] };
  await expect(stepsFor(execute, []).tool(input)).rejects.toThrow('not allowed');
  expect(execute).not.toHaveBeenCalled();
});
