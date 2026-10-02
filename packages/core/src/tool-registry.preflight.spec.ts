import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ToolPreflightResult } from './index.js';
import { DefaultRolesPolicy, ToolRegistry, createNoopEmitUi } from './index.js';

const ctx = {
  actor: { id: 'u1' },
  threadId: 't1',
  runId: 'r1',
  requestId: 'r1',
  emitUi: createNoopEmitUi(),
};
const policy = new DefaultRolesPolicy();
function setup(result: ToolPreflightResult, kind: 'action' | 'read' = 'action') {
  const registry = new ToolRegistry();
  const preflight = vi.fn(() => result);
  const execute = vi.fn(async () => 'changed');
  registry.register(
    {
      name: 'write',
      kind,
      description: 'write',
      inputSchema: z.object({ key: z.string().transform((s) => s.toUpperCase()) }),
    },
    { execute, preflight },
  );
  return { registry, preflight, execute };
}
describe('action preflight', () => {
  it('prepares validated input without executing', async () => {
    const { registry, preflight, execute } = setup({
      status: 'ready',
      confirmation: { title: 'Write 3 rows?', verb: 'Write' },
    });
    expect(await registry.prepare('write', { key: 'x' }, ctx, policy)).toEqual({
      status: 'ready',
      confirmation: { title: 'Write 3 rows?', verb: 'Write' },
    });
    expect(preflight).toHaveBeenCalledWith({ key: 'X' }, ctx, { phase: 'prepare' });
    expect(execute).not.toHaveBeenCalled();
  });
  it('returns an existing result on direct invocation without writing', async () => {
    const { registry, preflight, execute } = setup({ status: 'completed', output: 'existing' });
    expect(await registry.invoke('write', { key: 'x' }, ctx, policy)).toBe('existing');
    expect(preflight).toHaveBeenCalledWith({ key: 'X' }, ctx, { phase: 'execute' });
    expect(execute).not.toHaveBeenCalled();
  });
  it('refuses direct invocation when preflight denies', async () => {
    const { registry, execute } = setup({ status: 'denied', reason: 'already locked' });
    await expect(registry.invoke('write', { key: 'x' }, ctx, policy)).rejects.toThrow(
      'already locked',
    );
    expect(execute).not.toHaveBeenCalled();
  });
  it('never calls preflight for invalid or unauthorized input', async () => {
    const { registry, preflight } = setup({ status: 'ready' });
    await expect(registry.prepare('write', {}, ctx, policy)).rejects.toThrow('Invalid input');
    await expect(
      registry.prepare('write', { key: 'x' }, ctx, { can: () => false }),
    ).rejects.toThrow('not allowed');
    await expect(registry.invoke('write', {}, ctx, policy)).rejects.toThrow('Invalid input');
    expect(preflight).not.toHaveBeenCalled();
  });
  it('does not run preflight for read tools', async () => {
    const { registry, preflight } = setup({ status: 'denied', reason: 'no' }, 'read');
    expect(await registry.invoke('write', { key: 'x' }, ctx, policy)).toBe('changed');
    expect(preflight).not.toHaveBeenCalled();
  });
});
