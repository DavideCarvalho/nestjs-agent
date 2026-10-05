import {
  AgentRegistry,
  DefaultRolesPolicy,
  ToolRegistry,
  createNoopEmitUi,
} from '@dudousxd/nestjs-agent-core';
import { table } from '@dudousxd/nestjs-agent-core/genui';
import { FakeModelProvider } from '@dudousxd/nestjs-agent-testing';
import type { DiscoveryService } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AiTool } from './decorator/ai-tool.decorator.js';
import { AiToolDiscoveryService } from './discovery/ai-tool-discovery.service.js';
import { defineTool, provideAgentTool } from './functional-tool.js';

const context = () => ({
  actor: { id: 'u', roles: [] },
  threadId: 't',
  runId: 'r',
  requestId: 'q',
  emitUi: vi.fn(createNoopEmitUi()),
});

describe('Nest tool presentations', () => {
  it('authors and registers an object-form functional tool', async () => {
    const tool = defineTool({
      name: 'records',
      description: 'records',
      input: z.object({ n: z.number() }),
      execute: async (input) => ({ n: input.n }),
      present: async (output) => table({ columns: [{ key: 'n', label: 'N' }], rows: [output] }),
    });
    const provider = provideAgentTool(tool);
    expect(provider).toHaveProperty('useValue');
    const registry = new ToolRegistry();
    registry.register(tool.spec, tool.handler);
    const ctx = context();
    expect(await registry.invoke('records', { n: 1 }, ctx, new DefaultRolesPolicy())).toEqual({
      n: 1,
    });
    expect(ctx.emitUi).toHaveBeenCalledOnce();
  });
  it('forwards present from decorated classes with its receiver intact', async () => {
    @AiTool({ name: 'classRecords', description: 'records', input: z.object({}) })
    class Records {
      label = 'Class label';
      async execute() {
        return { n: 2 };
      }
      async present(output: { n: number }) {
        return table({ title: this.label, columns: [{ key: 'n', label: 'N' }], rows: [output] });
      }
    }
    const instance = new Records();
    const discovery = { getProviders: () => [{ instance }] } as unknown as DiscoveryService;
    const registry = new ToolRegistry();
    new AiToolDiscoveryService(discovery, registry, new AgentRegistry(), {
      model: new FakeModelProvider(() => ({ text: 'done' })),
    }).onApplicationBootstrap();
    const ctx = context();
    expect(await registry.invoke('classRecords', {}, ctx, new DefaultRolesPolicy())).toEqual({
      n: 2,
    });
    expect(ctx.emitUi).toHaveBeenCalledWith(
      'DataTable',
      expect.objectContaining({ title: 'Class label' }),
      expect.any(Object),
    );
  });
});
