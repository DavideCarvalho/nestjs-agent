import type { ExecutionContext } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import type { ModuleRef } from '@nestjs/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type DevToolsActions, DevToolsActionsGate, resolveActionsMap } from './actions.js';
import { libProblem, snapshot } from './catalog.js';
import {
  DEV_TOOLS_SLOT,
  type DevTool,
  type DevToolsLib,
  devToolsSlot,
  registerDevTools,
} from './contract.js';
import { callerOf } from './endpoint.js';
import { capDevToolResult, redactDevToolOutput, truncateText } from './limits.js';
import { resolveDevToolsOptions } from './options.js';
import { schemaProblem, validateDevToolInput } from './schema.js';

const tool = (overrides: Partial<DevTool> = {}): DevTool => ({
  name: 'durable_list_runs',
  kind: 'read',
  description: 'Runs.',
  input: { type: 'object', properties: { status: { type: 'string' } } },
  run: async () => ({ items: [], next: null }),
  ...overrides,
});

const lib = (overrides: Partial<DevToolsLib> = {}): DevToolsLib => ({
  lib: 'durable',
  title: 'Durable workflows',
  authorize: async () => ({ allowed: true }),
  tools: [tool()],
  ...overrides,
});

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[DEV_TOOLS_SLOT];
});

describe('the dev-tools slot', () => {
  it('is created once, on the registry symbol', () => {
    const slot = devToolsSlot();
    expect(slot.version).toBe(1);
    expect((globalThis as Record<symbol, unknown>)[Symbol.for('@dudousxd/aviary:dev-tools')]).toBe(
      slot,
    );
    expect(devToolsSlot()).toBe(slot);
  });

  it('rejects a duplicate lib id and unregisters cleanly', () => {
    const unregister = registerDevTools(lib());
    expect(() => registerDevTools(lib())).toThrow(/"durable" is already registered/);
    unregister?.();
    expect(devToolsSlot().libs).toEqual([]);
    expect(registerDevTools(lib())).toBeTypeOf('function');
  });

  it('does not register into a slot of another version', () => {
    (globalThis as Record<symbol, unknown>)[DEV_TOOLS_SLOT] = { version: 2, libs: [] };
    expect(registerDevTools(lib())).toBeUndefined();
    expect(snapshot(new Set()).libs).toEqual([]);
  });
});

describe('registration checks', () => {
  it('names what is wrong with a lib', () => {
    expect(libProblem(lib())).toBeNull();
    expect(libProblem(lib({ lib: 'Durable' }))).toMatch(/lib id/);
    expect(libProblem(lib({ tools: [tool({ name: 'durableListRuns' })] }))).toMatch(/snake_case/);
    expect(libProblem(lib({ tools: [tool({ name: 'telescope_list_runs' })] }))).toMatch(
      /prefixed by its lib/,
    );
    expect(libProblem(lib({ tools: [tool(), tool()] }))).toMatch(/registered twice/);
    // No authorize is a lib with no console, gated by the endpoint; a non-function one is wrong.
    const { authorize: _gate, ...consoleLess } = lib();
    expect(libProblem(consoleLess)).toBeNull();
    expect(libProblem({ ...lib(), authorize: 'yes' } as unknown as DevToolsLib)).toMatch(
      /not a function/,
    );
    expect(
      libProblem(
        lib({
          tools: [
            tool({
              input: {
                type: 'object',
                properties: { q: { type: 'object' as 'string' } },
              },
            }),
          ],
        }),
      ),
    ).toMatch(/type "object" is not allowed/);
  });

  it('skips an invalid lib and applies exclude by lib id or tool name', () => {
    registerDevTools(lib({ tools: [tool(), tool({ name: 'durable_get_run' })] }));
    registerDevTools(lib({ lib: 'bad', tools: [tool()] }));
    registerDevTools(lib({ lib: 'media', tools: [tool({ name: 'media_list_disks' })] }));
    const snap = snapshot(new Set(['durable_get_run', 'media']));
    expect(snap.rejected.map((entry) => entry.lib)).toEqual(['bad']);
    expect(snap.libs.map((entry) => [entry.lib, entry.tools.map((t) => t.name)])).toEqual([
      ['durable', ['durable_list_runs']],
      ['media', []],
    ]);
  });
});

describe('input schema subset', () => {
  it('refuses keywords outside the subset', () => {
    expect(schemaProblem({ type: 'object', properties: {}, additionalProperties: true })).toMatch(
      /outside the dev-tools schema subset/,
    );
    expect(
      schemaProblem({ type: 'object', properties: { a: { type: 'array', items: {} } } }),
    ).toMatch(/items/);
  });

  it('validates input, rejecting extra and mistyped fields', () => {
    const schema = {
      type: 'object' as const,
      properties: {
        id: { type: 'string' as const },
        limit: { type: 'integer' as const, minimum: 1, maximum: 100 },
        status: { type: 'string' as const, enum: ['running', 'failed'] },
      },
      required: ['id'],
    };
    expect(validateDevToolInput(schema, { id: 'r1', limit: 5 })).toEqual({
      value: { id: 'r1', limit: 5 },
    });
    const bad = validateDevToolInput(schema, { limit: 1.5, status: 'x', extra: 1 });
    expect('issues' in bad && bad.issues.map((issue) => issue.message)).toEqual([
      'unknown property "extra"',
      '"id" is required',
      '"limit" must be an integer',
      '"status" must be one of running, failed',
    ]);
  });
});

describe('limits and redaction', () => {
  it('strips secret-looking keys but keeps token counts', () => {
    expect(
      redactDevToolOutput({
        apiKey: 'k',
        nested: { password: 'p', authorization: 'Bearer x', cookie: 'c' },
        inputTokens: 12,
        hasPassword: true,
      }),
    ).toEqual({
      apiKey: '[redacted]',
      nested: { password: '[redacted]', authorization: '[redacted]', cookie: '[redacted]' },
      inputTokens: 12,
      hasPassword: true,
    });
  });

  it('caps a list result at 48 KB with truncated and next', () => {
    const items = Array.from({ length: 500 }, (_, i) => ({ id: i, text: 'x'.repeat(200) }));
    const text = capDevToolResult({ items, next: 2 });
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(48 * 1024);
    const parsed = JSON.parse(text) as { items: unknown[]; truncated: boolean; next: number };
    expect(parsed.truncated).toBe(true);
    expect(parsed.next).toBe(2);
    expect(parsed.items.length).toBeLessThan(500);
  });

  it('cuts a long field with its original size', () => {
    expect(truncateText('a'.repeat(5000), 100)).toMatch(/…\(truncated, 5000 bytes\)$/);
  });
});

describe('options', () => {
  it('defaults to mcp/aviary, read-only', () => {
    expect(resolveDevToolsOptions(undefined, 'mcp')).toEqual({
      path: 'mcp/aviary',
      exclude: new Set(),
      actions: 'refuse',
    });
    expect(resolveDevToolsOptions(false, 'mcp')).toBeUndefined();
  });

  it('refuses the product endpoint’s path', () => {
    expect(() => resolveDevToolsOptions({ path: '/mcp/' }, 'mcp')).toThrow(/own path/);
    expect(resolveDevToolsOptions({ path: 'mcp' }, false)?.path).toBe('mcp');
  });

  it('accepts the map and function forms of actions, and refuses anything else', () => {
    const map = { durable: () => true };
    expect(resolveDevToolsOptions({ actions: map }, 'mcp')?.actions).toBe(map);
    const fn = () => true;
    expect(resolveDevToolsOptions({ actions: fn }, 'mcp')?.actions).toBe(fn);
    expect(() => resolveDevToolsOptions({ actions: 42 as never }, 'mcp')).toThrow(
      /devTools.actions/,
    );
    expect(() => resolveDevToolsOptions({ actions: [1] as never }, 'mcp')).toThrow(
      /devTools.actions/,
    );
  });
});

describe('actions gate', () => {
  const retry = { lib: 'durable', tool: 'durable_retry_run', destructive: false };
  const cancel = { lib: 'durable', tool: 'durable_cancel_run', destructive: true };
  const refund = { lib: 'payments', tool: 'payments_refund_payment', destructive: true };
  const request = { user: { id: 7 } };
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  const caller = { id: 'user:7', via: 'session' } as const;

  async function gate(actions: DevToolsActions): Promise<DevToolsActionsGate> {
    const resolved = await resolveActionsMap(actions, {} as ModuleRef, new Logger('spec'));
    return new DevToolsActionsGate(actions, resolved, context, caller);
  }

  it('keeps the static forms: refuse, execute, a list of lib ids or tool names', async () => {
    expect(await (await gate('refuse')).decide(retry)).toEqual({ reason: 'not-configured' });
    expect(await (await gate('execute')).decide(retry)).toBe(true);
    expect(await (await gate(['durable'])).decide(retry)).toBe(true);
    expect(await (await gate(['media_abort_upload'])).decide(retry)).toEqual({
      reason: 'not-configured',
    });
    expect(await (await gate(null as never)).decide(retry)).toEqual({ reason: 'not-configured' });
    expect((await gate(['durable'])).dynamic).toBe(false);
  });

  it('map: a tool key wins over its lib key, and an action in neither is refused', async () => {
    const g = await gate({ durable: () => true, durable_cancel_run: () => false });
    expect(g.dynamic).toBe(true);
    expect(await g.decide(retry)).toBe(true);
    expect(await g.decide(cancel)).toEqual({ reason: 'denied' });
    expect(await g.decide(refund)).toEqual({ reason: 'not-configured' });
  });

  it('map: a throw, a redirectTo or unauthenticated refuses', async () => {
    const g = await gate({
      durable_retry_run: () => {
        throw new Error('boom');
      },
      durable_cancel_run: () => ({ redirectTo: '/login' }),
      payments: () => ({ allowed: false, reason: 'unauthenticated' }) as const,
    });
    expect(await g.decide(retry)).toEqual({ reason: 'denied' });
    expect(await g.decide(cancel)).toEqual({ reason: 'denied' });
    expect(await g.decide(refund)).toEqual({ reason: 'denied' });
  });

  it('map: never reads an inherited key', async () => {
    const g = await gate({ durable: () => true });
    expect(await g.decide({ ...retry, lib: 'constructor', tool: 'toString' })).toEqual({
      reason: 'not-configured',
    });
  });

  it('map: each distinct authorize runs once per request', async () => {
    const admins = vi.fn(() => true);
    const actions = { durable: admins, payments: admins };
    const resolved = await resolveActionsMap(actions, {} as ModuleRef, new Logger('spec'));
    const first = new DevToolsActionsGate(actions, resolved, context, caller);
    await Promise.all([first.decide(retry), first.decide(cancel), first.decide(refund)]);
    expect(admins).toHaveBeenCalledTimes(1);
    const second = new DevToolsActionsGate(actions, resolved, context, caller);
    await second.decide(retry);
    expect(admins).toHaveBeenCalledTimes(2);
  });

  it('function: gets the request and the action; only true serves, a throw refuses', async () => {
    const decide = vi.fn((_req: unknown, action: { destructive: boolean }) => !action.destructive);
    const g = await gate(decide);
    expect(await g.decide(retry)).toBe(true);
    expect(await g.decide(cancel)).toEqual({ reason: 'denied' });
    expect(decide).toHaveBeenCalledWith(request, { ...retry, caller });
    expect(await (await gate((() => 'yes') as never)).decide(retry)).toEqual({ reason: 'denied' });
    const error = new Error('boom');
    expect(
      await (
        await gate(() => {
          throw error;
        })
      ).decide(retry),
    ).toEqual({ reason: 'threw', error });
  });

  it('fails the boot on an authorize form it cannot resolve', async () => {
    await expect(gate({ durable: 42 as never })).rejects.toThrow(/authorize/);
  });
});

describe('actions map at boot', () => {
  it('names the map key whose authorize cannot resolve', async () => {
    const moduleRef = {
      get: () => {
        throw new Error('no console gate');
      },
    } as unknown as ModuleRef;
    await expect(
      resolveActionsMap(
        { durable: () => true, 'flags.save': 'flags.admin' },
        moduleRef,
        new Logger('spec'),
      ),
    ).rejects.toThrow(/devTools\.actions\['flags\.save'\]/);
  });
});

describe('caller id', () => {
  it('is the caller the allowing decision named (a token form, hashed)', () => {
    const decisions = [
      { allowed: false, reason: 'forbidden' } as const,
      { allowed: true, caller: 'token:3f9a1c2b7d10' } as const,
    ];
    expect(callerOf({ user: { id: 1 } }, decisions)).toEqual({
      id: 'token:3f9a1c2b7d10',
      via: 'token',
    });
  });

  it('falls back to request.user, then session; dev-open only for the open default', () => {
    const allowed = [{ allowed: true } as const];
    expect(callerOf({ user: { id: 42 } }, allowed)).toEqual({ id: 'user:42', via: 'session' });
    expect(callerOf({}, allowed)).toEqual({ id: 'session', via: 'session' });
    const open = [{ allowed: true, caller: 'dev-open' } as const];
    expect(callerOf({}, open)).toEqual({ id: 'dev-open', via: 'open' });
    expect(callerOf({ user: { id: 42 } }, open)).toEqual({ id: 'user:42', via: 'session' });
    expect(callerOf({}, [{ allowed: false, reason: 'unauthenticated' }])).toEqual({
      id: 'anonymous',
      via: 'open',
    });
  });
});
