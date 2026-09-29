import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AiToolCtx, ToolDescribeScope } from './spi/tool.js';
import { DefaultRolesPolicy, ToolRegistry } from './tool-registry.js';

const ACTOR = { id: 'u1', roles: ['ADMIN'], tenantRef: 'acme' };
const policy = new DefaultRolesPolicy();

describe('ToolRegistry — per-turn describe', () => {
  it('replaces description and schema with what describe returns for this scope', async () => {
    const registry = new ToolRegistry();
    const seen: ToolDescribeScope[] = [];
    const perTenant = z.object({ q: z.string() });
    registry.register(
      { name: 'dyn', kind: 'read', description: 'static', inputSchema: z.object({}) },
      {
        execute: async () => 'ok',
        describe: (scope) => {
          seen.push(scope);
          return { description: `for ${scope.actor.tenantRef}`, inputSchema: perTenant };
        },
      },
    );
    registry.register(
      { name: 'plain', kind: 'read', description: 'plain', inputSchema: z.object({}) },
      { execute: async () => 'ok', describe: () => undefined },
    );
    const [dyn, plain] = await registry.definitionsFor(ACTOR, policy, undefined, {
      threadId: 't1',
      agentName: 'default',
    });
    expect(dyn).toMatchObject({ name: 'dyn', description: 'for acme', inputSchema: perTenant });
    expect(plain).toMatchObject({ name: 'plain', description: 'plain' });
    expect(seen).toEqual([{ actor: ACTOR, threadId: 't1', agentName: 'default' }]);
  });

  it('never asks a tool the actor cannot reach to describe itself', async () => {
    const registry = new ToolRegistry();
    let asked = false;
    registry.register(
      { name: 'x', kind: 'read', description: 'd', inputSchema: z.object({}), roles: ['OTHER'] },
      {
        execute: async () => 'ok',
        describe: () => {
          asked = true;
          return undefined;
        },
      },
    );
    expect(await registry.definitionsFor(ACTOR, policy)).toEqual([]);
    expect(asked).toBe(false);
  });
});

describe('ToolRegistry — emitUi is always there', () => {
  it('hands a no-op emitUi to a tool invoked without one', async () => {
    const registry = new ToolRegistry();
    registry.register(
      { name: 'show', kind: 'read', description: 'd', inputSchema: z.object({}) },
      { execute: async (_input, ctx) => ctx.emitUi('Chart', { x: 1 }) },
    );
    const ctx = { actor: ACTOR, threadId: 't', runId: 'r', requestId: 'req' } as AiToolCtx;
    await expect(registry.invoke('show', {}, ctx, policy)).resolves.toEqual({ id: 'req:ui:0' });
  });
});
