import { describe, expect, it } from 'vitest';
import type { LiveAgentEvent } from './agent-client';
import { type FeedEvent, isAlertEvent, pushLiveEvent } from './merge-live-events';

function event(over: Partial<LiveAgentEvent> = {}): LiveAgentEvent {
  return { event: 'message', ts: 1, payload: {}, ...over };
}

describe('pushLiveEvent', () => {
  it('prepends newest-first and assigns a unique id', () => {
    let feed: FeedEvent[] = [];
    feed = pushLiveEvent(feed, event({ event: 'a', ts: 1 }), 0);
    feed = pushLiveEvent(feed, event({ event: 'b', ts: 2 }), 1);
    expect(feed.map((e) => e.event)).toEqual(['b', 'a']);
    expect(new Set(feed.map((e) => e.id)).size).toBe(2);
  });

  it('caps the feed at capacity', () => {
    let feed: FeedEvent[] = [];
    for (let i = 0; i < 10; i += 1) feed = pushLiveEvent(feed, event({ ts: i }), i, 3);
    expect(feed).toHaveLength(3);
    expect(feed[0]?.ts).toBe(9);
  });

  it('does not mutate the previous array', () => {
    const prev: FeedEvent[] = [];
    pushLiveEvent(prev, event(), 0);
    expect(prev).toHaveLength(0);
  });
});

describe('isAlertEvent', () => {
  it('flags quota breaches and denied/failed statuses', () => {
    expect(isAlertEvent(event({ event: 'quota.exceeded' }))).toBe(true);
    expect(isAlertEvent(event({ event: 'tool-call', payload: { status: 'forbidden' } }))).toBe(
      true,
    );
    expect(isAlertEvent(event({ event: 'tool-call', payload: { status: 'ok' } }))).toBe(false);
    expect(isAlertEvent(event({ event: 'message' }))).toBe(false);
  });
});
