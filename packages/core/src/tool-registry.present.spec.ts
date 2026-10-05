import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { table } from './genui/index.js';
import {
  type AiToolCtx,
  DefaultRolesPolicy,
  ToolRegistry,
  createFunctionalTool,
  createNoopEmitUi,
} from './index.js';

const ctx = (): AiToolCtx => ({
  actor: { id: 'u', roles: [] },
  threadId: 't',
  runId: 'r',
  requestId: 'q',
  emitUi: createNoopEmitUi(),
});
const spec = {
  name: 'records',
  kind: 'action' as const,
  description: 'records',
  inputSchema: z.object({}),
};
const policy = new DefaultRolesPolicy();

describe('tool output presentation', () => {
  it('preserves output and this while emitting presentations', async () => {
    const registry = new ToolRegistry();
    const output = { rows: [{ x: 1 }] };
    const handler = {
      label: 'X',
      execute: async () => output,
      async present(value: typeof output) {
        return table({ columns: [{ key: 'x', label: this.label }], rows: value.rows });
      },
    };
    registry.register(spec, handler);
    const context = ctx();
    context.emitUi = vi.fn(context.emitUi);
    expect(await registry.invoke('records', {}, context, policy)).toBe(output);
    expect(context.emitUi).toHaveBeenCalledWith(
      'DataTable',
      { columns: [{ key: 'x', label: 'X' }], rows: output.rows },
      expect.objectContaining({ version: 1, fallbackText: expect.any(String) }),
    );
  });
  it('presents completed preflight output without executing the action', async () => {
    const registry = new ToolRegistry();
    const execute = vi.fn(async () => 'executed');
    const present = vi.fn(async () => undefined);
    registry.register(spec, {
      execute,
      preflight: () => ({ status: 'completed', output: 'already done' }),
      present,
    });
    expect(await registry.invoke('records', {}, ctx(), policy)).toBe('already done');
    expect(execute).not.toHaveBeenCalled();
    expect(present).toHaveBeenCalledWith('already done', expect.any(Object));
  });
  it('does not present denied, forbidden or failed actions', async () => {
    for (const mode of ['denied', 'forbidden', 'failed']) {
      const registry = new ToolRegistry();
      const present = vi.fn(async () => undefined);
      registry.register(spec, {
        execute: async () => {
          throw new Error('domain failed');
        },
        preflight: () =>
          mode === 'denied' ? { status: 'denied', reason: 'no' } : { status: 'ready' },
        present,
      });
      await expect(
        registry.invoke('records', {}, ctx(), mode === 'forbidden' ? { can: () => false } : policy),
      ).rejects.toThrow();
      expect(present).not.toHaveBeenCalled();
    }
  });
  it('reports presentation failures without replaying successful side effects', async () => {
    const registry = new ToolRegistry();
    let writes = 0;
    registry.register(spec, {
      execute: async () => ++writes,
      present: async () => {
        throw new Error('render failed');
      },
    });
    const context = ctx();
    context.onPresentationError = vi.fn(() => {
      throw new Error('reporter failed');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await registry.invoke('records', {}, context, policy)).toBe(1);
      expect(writes).toBe(1);
      expect(context.onPresentationError).toHaveBeenCalledWith(expect.any(Error), {
        toolName: 'records',
      });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('presentation'), expect.any(Error));
    } finally {
      warn.mockRestore();
    }
  });
  it('validates the entire batch before emitting anything', async () => {
    const registry = new ToolRegistry();
    const good = await table({ columns: [{ key: 'x', label: 'X' }], rows: [] });
    registry.register(spec, {
      execute: async () => 'done',
      present: () => [good, { ...good, props: { invalid: () => undefined } }],
    });
    const context = ctx();
    context.emitUi = vi.fn(context.emitUi);
    context.onPresentationError = vi.fn();
    expect(await registry.invoke('records', {}, context, policy)).toBe('done');
    expect(context.emitUi).not.toHaveBeenCalled();
    expect(context.onPresentationError).toHaveBeenCalled();
  });
  it('creates functional tools with inferred input/output and bound author methods', async () => {
    const author = {
      name: 'records',
      description: 'records',
      input: z.object({ count: z.number() }),
      execute: async (input: { count: number }) => ({ count: input.count }),
      async present(value: { count: number }) {
        return table({
          title: this.description,
          columns: [{ key: 'count', label: 'Count' }],
          rows: [value],
        });
      },
    };
    const functional = createFunctionalTool(author);
    const registry = new ToolRegistry();
    registry.register(functional.spec, functional.handler);
    const context = ctx();
    context.emitUi = vi.fn(context.emitUi);
    expect(await registry.invoke('records', { count: 2 }, context, policy)).toEqual({ count: 2 });
    expect(context.emitUi).toHaveBeenCalledWith(
      'DataTable',
      expect.objectContaining({ title: 'records' }),
      expect.any(Object),
    );
  });
});
