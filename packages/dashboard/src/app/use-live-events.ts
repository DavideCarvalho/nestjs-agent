import { useEffect, useRef, useState } from 'react';
import { agentClient } from '../client/agent-client';
import { type FeedEvent, pushLiveEvent } from '../client/merge-live-events';

/**
 * Subscribe to the live `aviary:agent:*` SSE stream for the lifetime of the component and accumulate
 * events into a bounded, newest-first feed. `seq` (a ref) disambiguates same-millisecond events so
 * every `FeedEvent.id` stays unique. The EventSource is closed on unmount.
 */
export function useLiveEvents(capacity = 200): { events: FeedEvent[]; connected: boolean } {
  const [events, setEvents] = useState<FeedEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    setConnected(true);
    const close = agentClient.streamEvents((event) => {
      seq.current += 1;
      setEvents((prev) => pushLiveEvent(prev, event, seq.current, capacity));
    });
    return () => {
      setConnected(false);
      close();
    };
  }, [capacity]);

  return { events, connected };
}
