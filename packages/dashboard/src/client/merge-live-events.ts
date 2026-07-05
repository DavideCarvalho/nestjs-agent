import type { LiveAgentEvent } from './agent-client';

/** A live event with a stable client-assigned id, so React can key the feed without server ids. */
export interface FeedEvent extends LiveAgentEvent {
  /** Monotonic client id (`ts`-prefixed) — stable across re-renders, unique within a session. */
  id: string;
}

/** Default number of live events the feed retains (a bounded ring so a long session can't grow unbounded). */
export const DEFAULT_FEED_CAPACITY = 200;

/**
 * Prepend a freshly-received live event onto the feed (newest first) and cap the list at `capacity`.
 * `seq` disambiguates two events sharing the same `ts` so the generated `id` stays unique. Pure —
 * returns a new array, never mutates `prev`.
 */
export function pushLiveEvent(
  prev: FeedEvent[],
  event: LiveAgentEvent,
  seq: number,
  capacity: number = DEFAULT_FEED_CAPACITY,
): FeedEvent[] {
  const entry: FeedEvent = { ...event, id: `${event.ts}-${seq}` };
  return [entry, ...prev].slice(0, capacity);
}

/** True when a live event denotes a governance breach the Live feed should surface loudly. */
export function isAlertEvent(event: LiveAgentEvent): boolean {
  if (event.event === 'quota.exceeded') return true;
  const status = event.payload.status;
  return typeof status === 'string' && /forbidden|denied|error|failed/i.test(status);
}
