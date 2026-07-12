import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { channelName } from '@dudousxd/nestjs-diagnostics';
import { describe, expect, it } from 'vitest';
import {
  AGENT_DIAGNOSTIC_EVENTS,
  type AgentDiagnosticEvent,
  type AgentDiagnosticKey,
  agentDiagnosticKey,
  publishAgentRunStarted,
} from './index.js';

describe('diagnostics', () => {
  it('emits on aviary:agent:run.started', () => {
    const name = channelName('agent', 'run.started');
    const seen: unknown[] = [];
    const handler = (message: unknown) => seen.push(message);
    subscribe(name, handler);
    try {
      publishAgentRunStarted({ runId: 'r1', threadId: 't1', actorId: 'u1' });
    } finally {
      unsubscribe(name, handler);
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ payload: { runId: 'r1', threadId: 't1', actorId: 'u1' } });
  });
});

describe('AGENT_DIAGNOSTIC_EVENTS', () => {
  // The type-level guarantee lives in diagnostics.ts (AgentDiagnosticEventsCoverAllKeys); this is
  // the runtime companion so a drift also fails a plain `vitest run`, not only `tsc`.
  const expectedEvents: AgentDiagnosticEvent[] = [
    'run.started',
    'message',
    'tool-call',
    'quota.exceeded',
    'run.finished',
    'run.failed',
    'delegated',
    'retrieved',
  ];

  it("lists all 8 ChannelRegistry['agent'] events, in a stable order", () => {
    expect(AGENT_DIAGNOSTIC_EVENTS).toHaveLength(8);
    expect(AGENT_DIAGNOSTIC_EVENTS).toEqual(expectedEvents);
  });

  it('has no duplicate events', () => {
    expect(new Set(AGENT_DIAGNOSTIC_EVENTS).size).toBe(AGENT_DIAGNOSTIC_EVENTS.length);
  });
});

describe('agentDiagnosticKey', () => {
  it('composes the agent:<event> telescope key', () => {
    expect(agentDiagnosticKey('run.started')).toBe('agent:run.started');
    expect(agentDiagnosticKey('quota.exceeded')).toBe('agent:quota.exceeded');
  });

  it('produces the exact key the diagnostics-telescope bridge groups by (lib:event)', () => {
    for (const event of AGENT_DIAGNOSTIC_EVENTS) {
      expect(agentDiagnosticKey(event)).toBe(`agent:${event}`);
    }
  });

  it('is typed as AgentDiagnosticKey (agent:<event> template literal)', () => {
    const key: AgentDiagnosticKey = agentDiagnosticKey('retrieved');
    expect(key).toBe('agent:retrieved');
    // @ts-expect-error — a non-agent prefix is not assignable to AgentDiagnosticKey.
    const bad: AgentDiagnosticKey = 'billing:retrieved';
    expect(bad).toBe('billing:retrieved');
  });
});
