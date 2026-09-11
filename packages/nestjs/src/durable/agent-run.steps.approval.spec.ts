import { DefaultRolesPolicy, ToolRegistry } from '@dudousxd/nestjs-agent-core';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AgentDepsFactory } from '../agent-deps.factory.js';
import { AgentRunSteps } from './agent-run.steps.js';
import type { DispatchedToolInput } from './agent-run.steps.js';

function stepsFor(execute: () => Promise<unknown>): AgentRunSteps {
  const registry = new ToolRegistry();
  registry.register(
    { name: 'purgeCache', kind: 'action', description: 'purge', inputSchema: z.object({}) },
    { execute },
  );
  const factory = {
    forAgent: () => ({ registry, rolesPolicy: new DefaultRolesPolicy() }),
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
