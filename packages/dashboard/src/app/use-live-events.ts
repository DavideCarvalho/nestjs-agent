import { useEffect, useRef, useState } from 'react';
import { agentClient, selectedApp } from '../client/agent-client';
import { type FeedEvent, pushLiveEvent } from '../client/merge-live-events';

/**
 * Subscribe to the live `aviary:agent:*` SSE stream for the lifetime of the component and accumulate
 * events into a bounded, newest-first feed. `seq` (a ref) disambiguates same-millisecond events so
 * every `FeedEvent.id` stays unique. The EventSource is closed on unmount. With a federated app
 * selected there is nothing to tail (the server answers 501), so it stays disconnected.
 */
export function useLiveEvents(capacity = 200): { events: FeedEvent[]; connected: boolean } {
  const [events, setEvents] = useState<FeedEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    // A federated app's events never reach this console's process: no stream to tail.
    if (selectedApp() !== undefined) return;
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
