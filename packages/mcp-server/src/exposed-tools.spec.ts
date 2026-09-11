import type { ToolKind } from '@dudousxd/nestjs-agent-core';
import { describe, expect, it } from 'vitest';
import {
  McpToolNotExposedError,
  assertToolExposedOverMcp,
  isToolExposedOverMcp,
  mcpExposureRefusal,
} from './exposed-tools.js';

const LOOP_SERVED_KINDS: ToolKind[] = ['agent', 'ask', 'skill', 'memory'];

describe('mcpExposureRefusal', () => {
  it('exposes a read tool', () => {
    expect(mcpExposureRefusal({ name: 'search', kind: 'read', actions: 'deny' })).toBeUndefined();
  });

  it('refuses an action tool by default, naming the approval it cannot get', () => {
    const refusal = mcpExposureRefusal({ name: 'purge', kind: 'action', actions: 'deny' });
    expect(refusal).toMatch(/approval/);
  });

  it('exposes an action tool only where the deployment opted in', () => {
    expect(
      mcpExposureRefusal({ name: 'purge', kind: 'action', actions: 'execute' }),
    ).toBeUndefined();
  });

  it('refuses every loop-served kind, even under the action opt-in', () => {
    // Their registered handler performs nothing — an `agent` tool's stub answers `{}` and delegates
    // to nobody, because the loop is what runs the delegation.
    for (const kind of LOOP_SERVED_KINDS) {
      expect(mcpExposureRefusal({ name: 'x', kind, actions: 'execute' })).toMatch(/agent loop/);
    }
  });

  it('refuses a tool the deployment left off its allow-list, whatever its kind', () => {
    expect(
      mcpExposureRefusal({
        name: 'secret_read',
        kind: 'read',
        actions: 'deny',
        allowedTools: ['search'],
      }),
    ).toMatch(/does not list it/);
  });

  it('exposes a listed tool', () => {
    expect(
      isToolExposedOverMcp({
        name: 'search',
        kind: 'read',
        actions: 'deny',
        allowedTools: ['search'],
      }),
    ).toBe(true);
  });

  it('treats an empty allow-list as exposing nothing, not as no allow-list', () => {
    expect(
      isToolExposedOverMcp({ name: 'search', kind: 'read', actions: 'deny', allowedTools: [] }),
    ).toBe(false);
  });
});

describe('assertToolExposedOverMcp', () => {
  it('throws with the tool name and the reason', () => {
    let thrown: unknown;
    try {
      assertToolExposedOverMcp({ name: 'purge', kind: 'action', actions: 'deny' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(McpToolNotExposedError);
    expect(thrown).toMatchObject({ toolName: 'purge' });
    expect(() =>
      assertToolExposedOverMcp({ name: 'purge', kind: 'action', actions: 'deny' }),
    ).toThrow(/approval/);
  });

  it('passes an exposed tool through', () => {
    expect(() =>
      assertToolExposedOverMcp({ name: 'search', kind: 'read', actions: 'deny' }),
    ).not.toThrow();
  });
});
