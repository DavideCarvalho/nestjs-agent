import { describe, expect, it } from 'vitest';
import { type AgentStreamEvent, decodeStreamEvent, encodeStreamEvent } from './stream-events.js';

const decoder = new TextDecoder();

function roundTrip(event: AgentStreamEvent): AgentStreamEvent | null {
  return decodeStreamEvent(decoder.decode(encodeStreamEvent(event)).trimEnd());
}

describe('stream events', () => {
  it('round-trips the generative-UI, title and approval frames', () => {
    const events: AgentStreamEvent[] = [
      { kind: 'ui', id: 'ui-1', component: 'data-table', props: { rows: [] }, version: 2 },
      { kind: 'title', title: 'Quarterly revenue' },
      {
        kind: 'approval-requested',
        id: 'call-1',
        approver: 'admin',
        expiresAt: '2026-10-01T00:00:00.000Z',
        reason: 'Sends an email to a customer',
      },
      {
        kind: 'tool-input-start',
        id: 'call-2',
        name: 'search',
        toolKind: 'read',
        parentId: 'call-0',
      },
    ];
    for (const event of events) {
      expect(roundTrip(event)).toEqual(event);
    }
  });

  it('decodes a kind this version does not know, so a reader can forward it', () => {
    expect(decodeStreamEvent('{"kind":"from-the-future","x":1}')).toEqual({
      kind: 'from-the-future',
      x: 1,
    });
  });
});
