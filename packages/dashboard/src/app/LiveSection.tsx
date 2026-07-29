import type { FeedEvent } from '../client/merge-live-events';
import { isAlertEvent } from '../client/merge-live-events';
import { Badge } from './ui/badge';
import { Empty, Panel, StatusDot, relTime } from './ui/kit';

/** A short human summary for a live event, pulled from the well-known payload fields. */
function summarize(event: FeedEvent): string {
  const payload = event.payload;
  switch (event.event) {
    case 'run.started':
      return `run ${str(payload.runId)} started${payload.agentName ? ` · ${str(payload.agentName)}` : ''}`;
    case 'run.finished':
      return `run ${str(payload.runId)} finished · ${num(payload.steps)} steps · ${num(payload.inputTokens) + num(payload.outputTokens)} tok`;
    case 'message':
      return `${str(payload.role)} message · ${num(payload.textLength)} chars`;
    case 'tool-call':
      return `${str(payload.toolName)} (${str(payload.toolType)}) · ${str(payload.status)}`;
    case 'quota.exceeded':
      return `actor ${str(payload.actorId)} over budget · ${num(payload.usedTokens)}/${num(payload.limitTokens)} tok`;
    case 'delegated':
      return `delegated to ${str(payload.toAgent)}${payload.fromAgent ? ` from ${str(payload.fromAgent)}` : ''}`;
    default:
      return event.event;
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : value === undefined ? '' : String(value);
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** The live diagnostics feed: newest-first `aviary:agent:*` events streamed over SSE. */
export function LiveSection({
  events,
  connected,
}: {
  events: FeedEvent[];
  connected: boolean;
}) {
  return (
    <Panel
      title="Live activity"
      subtitle="Streaming aviary:agent:* diagnostics events"
      right={
        <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <StatusDot tone={connected ? 'live' : 'bad'} />
          {connected ? 'connected' : 'disconnected'}
        </span>
      }
    >
      {events.length === 0 ? (
        <Empty label={connected ? 'Waiting for live events…' : 'Live stream not connected'} />
      ) : (
        <ul className="max-h-[520px] space-y-0.5 overflow-y-auto">
          {events.map((event) => {
            const alert = isAlertEvent(event);
            return (
              <li
                key={event.id}
                className="rise flex items-center gap-3 rounded-md px-2 py-1.5 text-xs hover:bg-panel-2"
              >
                <Badge
                  variant={alert ? 'bad' : 'accent'}
                  className="w-32 shrink-0 truncate px-1.5 py-0.5 uppercase tracking-wider"
                >
                  {event.event}
                </Badge>
                <span className="mono truncate text-foreground">{summarize(event)}</span>
                <span className="mono ml-auto shrink-0 text-[10px] text-muted-foreground">
                  {relTime(event.ts)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
