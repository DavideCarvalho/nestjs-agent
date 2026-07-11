import { describe, expect, it } from 'vitest';
import { agentManagedTables } from './ensure-schema';

describe('agentManagedTables', () => {
  it('returns the six agent table names', () => {
    expect(agentManagedTables().sort()).toEqual([
      'agent_message',
      'agent_model_pricing',
      'agent_run',
      'agent_thread',
      'agent_token_usage',
      'agent_tool_call',
    ]);
  });

  it('does NOT include the schema-meta marker table (mirrors durableManagedTables, not telescopeManagedTables)', () => {
    expect(agentManagedTables()).not.toContain('agent_schema_meta');
  });

  it('returns a fresh array each call (no shared mutable state)', () => {
    const first = agentManagedTables();
    const second = agentManagedTables();
    expect(first).not.toBe(second);
    expect(first).toEqual(second);
  });
});
