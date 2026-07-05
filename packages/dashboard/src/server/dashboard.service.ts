import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import type {
  ActorSpendRow,
  AgentGovernanceQueries,
  GovernanceRange,
  ModelSpendRow,
  ThreadActivityRow,
  ToolCallActivityRow,
  UsageTrendPoint,
} from '@dudousxd/nestjs-agent-core';
import { channelName } from '@dudousxd/nestjs-diagnostics';
import { Inject, Injectable } from '@nestjs/common';
import { Observable } from 'rxjs';
import { AGENT_GOVERNANCE_QUERIES } from './tokens.js';

/** The spend/usage overview the SPA renders on its headline section (`GET <api>/spend`). */
export interface SpendOverview {
  byModel: ModelSpendRow[];
  byActor: ActorSpendRow[];
  trend: UsageTrendPoint[];
}

/** One live agent event forwarded over SSE, flattened from the `aviary:agent:*` diagnostics envelope. */
export interface LiveAgentEvent {
  /** The event name, e.g. `run.started` / `tool-call` / `quota.exceeded`. */
  event: string;
  /** Epoch millis the event was emitted. */
  ts: number;
  /** The library-defined payload (see the `Agent*Event` shapes in core's diagnostics). */
  payload: Record<string, unknown>;
}

/** The `aviary:agent:*` events the Live feed tails. Mirrors the telescope watcher's subscription. */
const AGENT_EVENTS = [
  'run.started',
  'message',
  'tool-call',
  'quota.exceeded',
  'run.finished',
  'delegated',
] as const;

/** The `node:diagnostics_channel` envelope `emit()` publishes (see `@dudousxd/nestjs-diagnostics`). */
interface AgentDiagnosticEnvelope {
  event: string;
  ts?: number;
  payload?: Record<string, unknown>;
}

/** Narrow the untyped diagnostics-channel message to the envelope we forward. */
function isAgentEnvelope(message: unknown): message is AgentDiagnosticEnvelope {
  return (
    typeof message === 'object' &&
    message !== null &&
    'event' in message &&
    typeof (message as { event: unknown }).event === 'string'
  );
}

/**
 * Read-model + live bridge backing the AI-gateway console.
 *
 * - Historical, restart-surviving spend/usage/threads come from the injected
 *   {@link AGENT_GOVERNANCE_QUERIES} read-model (backed by a store adapter). The host must provide
 *   that token — bind it via your `@dudousxd/nestjs-agent` module (global) alongside this dashboard.
 * - Live activity comes off the `aviary:agent:*` diagnostics channel, subscribed per SSE client and
 *   unsubscribed when the client disconnects.
 */
@Injectable()
export class DashboardService {
  constructor(@Inject(AGENT_GOVERNANCE_QUERIES) private readonly queries: AgentGovernanceQueries) {}

  /** Spend/usage overview for a day range: by-model + by-actor spend and the daily trend, in parallel. */
  async spend(range: GovernanceRange): Promise<SpendOverview> {
    const [byModel, byActor, trend] = await Promise.all([
      this.queries.spendByModel(range),
      this.queries.spendByActor(range),
      this.queries.usageTrend(range),
    ]);
    return { byModel, byActor, trend };
  }

  /** Most recent tool calls (status/type/thread) for the Runs & tools activity feed. */
  recentToolCalls(limit: number): Promise<ToolCallActivityRow[]> {
    return this.queries.recentToolCalls(limit);
  }

  /** Most recent threads with rolled-up message/token counts. */
  recentThreads(limit: number): Promise<ThreadActivityRow[]> {
    return this.queries.recentThreads(limit);
  }

  /**
   * Live SSE stream of `aviary:agent:*` diagnostics events. One subscription per SSE client:
   * subscribing wires a handler onto each agent channel; the returned teardown removes them all when
   * the client disconnects (or the observable is otherwise unsubscribed).
   */
  streamEvents(): Observable<{ data: LiveAgentEvent }> {
    return new Observable<{ data: LiveAgentEvent }>((subscriber) => {
      const bindings = AGENT_EVENTS.map((event) => {
        const name = channelName('agent', event);
        const handler = (message: unknown): void => {
          if (!isAgentEnvelope(message)) return;
          subscriber.next({
            data: {
              event: message.event,
              ts: message.ts ?? Date.now(),
              payload: message.payload ?? {},
            },
          });
        };
        subscribe(name, handler);
        return { name, handler };
      });
      return () => {
        for (const binding of bindings) unsubscribe(binding.name, binding.handler);
      };
    });
  }
}
