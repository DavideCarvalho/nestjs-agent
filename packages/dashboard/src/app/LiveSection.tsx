import type { FeedEvent } from '../client/merge-live-events';
import { isAlertEvent } from '../client/merge-live-events';
import { Empty, Panel, relTime } from './ui';

/** A short human summary for a live event, pulled from the well-known payload fields. */
function summarize(event: FeedEvent): string {
  const payload = event.payload;
  switch (event.event) {
    case 'run.started':
      return `run ${str(payload.runId)} started${payload.persona ? ` · ${str(payload.persona)}` : ''}`;
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
        <span className="flex items-center gap-1.5 text-[11px] text-[var(--muted)]">
          <span className={`dot ${connected ? 's-ok pulse' : 's-failed'}`} aria-hidden />
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
                className="rise flex items-center gap-3 rounded-md px-2 py-1.5 text-xs hover:bg-[var(--panel-2)]"
              >
                <span
                  className={`mono w-32 shrink-0 truncate rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${
                    alert
                      ? 'border-[var(--bad)]/50 text-[var(--bad)]'
                      : 'border-[var(--line)] text-[var(--accent)]'
                  }`}
                >
                  {event.event}
                </span>
                <span className="mono truncate text-[var(--text)]">{summarize(event)}</span>
                <span className="mono ml-auto shrink-0 text-[10px] text-[var(--muted)]">
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
