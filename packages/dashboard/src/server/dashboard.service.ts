import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import type {
  ActorSpendRow,
  AgentGovernanceQueries,
  AgentPricingStore,
  CurrentModelPrice,
  GovernanceRange,
  ModelSpendRow,
  ThreadActivityRow,
  ThreadSpendRow,
  ToolCallActivityRow,
  UsageTrendPoint,
} from '@dudousxd/nestjs-agent-core';
import { channelName } from '@dudousxd/nestjs-diagnostics';
import { Inject, Injectable, NotImplementedException, Optional } from '@nestjs/common';
import { Observable } from 'rxjs';
import type { ActorDirectory } from './actor-directory.js';
import { parsePriceInput } from './parse-price-input.js';
import { AGENT_ACTOR_DIRECTORY, AGENT_GOVERNANCE_QUERIES, AGENT_PRICING_STORE } from './tokens.js';

/** An actor-scoped row decorated with its resolved display label — `null` when unbound or unresolved. */
export interface WithActorLabel {
  actorLabel: string | null;
}

export type ActorSpendRowWithLabel = ActorSpendRow & WithActorLabel;
export type ThreadSpendRowWithLabel = ThreadSpendRow & WithActorLabel;
export type ThreadActivityRowWithLabel = ThreadActivityRow & WithActorLabel;

/** The spend/usage overview the SPA renders on its headline section (`GET <api>/spend`). */
export interface SpendOverview {
  byModel: ModelSpendRow[];
  byActor: ActorSpendRowWithLabel[];
  trend: UsageTrendPoint[];
}

/** The message returned as a 501 when no `AGENT_PRICING_STORE` is bound. */
const PRICING_STORE_UNBOUND_MESSAGE =
  'Pricing CRUD is unavailable: no AGENT_PRICING_STORE is bound. Bind a pricing store (e.g. ' +
  'MikroOrmPricingStore from @dudousxd/nestjs-agent-store-mikro-orm) to enable it.';

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
 * - `actorLabel` on actor-scoped rows comes from the OPTIONAL {@link AGENT_ACTOR_DIRECTORY} — `null`
 *   on every row when nothing is bound, so the console degrades to raw `actorRef`s instead of failing.
 * - Pricing CRUD (`listPrices`/`upsertPrice`) reads/writes the OPTIONAL {@link AGENT_PRICING_STORE} —
 *   a 501 with a clear message when nothing is bound.
 */
@Injectable()
export class DashboardService {
  constructor(
    @Inject(AGENT_GOVERNANCE_QUERIES) private readonly queries: AgentGovernanceQueries,
    @Optional()
    @Inject(AGENT_ACTOR_DIRECTORY)
    private readonly actorDirectory?: ActorDirectory,
    @Optional()
    @Inject(AGENT_PRICING_STORE)
    private readonly pricingStore?: AgentPricingStore,
  ) {}

  /** Spend/usage overview for a day range: by-model + by-actor spend and the daily trend, in parallel. */
  async spend(range: GovernanceRange): Promise<SpendOverview> {
    const [byModel, byActorRaw, trend] = await Promise.all([
      this.queries.spendByModel(range),
      this.queries.spendByActor(range),
      this.queries.usageTrend(range),
    ]);
    const byActor = await this.withActorLabels(byActorRaw);
    return { byModel, byActor, trend };
  }

  /** Top threads by cost for a day range (default 10, highest cost first). */
  async topThreads(range: GovernanceRange, limit = 10): Promise<ThreadSpendRowWithLabel[]> {
    const rows = await this.queries.spendByThread(range, limit);
    return this.withActorLabels(rows);
  }

  /** Most recent tool calls (status/type/thread) for the Runs & tools activity feed. */
  recentToolCalls(limit: number): Promise<ToolCallActivityRow[]> {
    return this.queries.recentToolCalls(limit);
  }

  /** Most recent threads with rolled-up message/token counts. */
  async recentThreads(limit: number): Promise<ThreadActivityRowWithLabel[]> {
    const rows = await this.queries.recentThreads(limit);
    return this.withActorLabels(rows);
  }

  /**
   * Decorate actor-scoped rows with `actorLabel`, batching the distinct `actorRef`s into ONE
   * {@link ActorDirectory.resolveDisplay} call per response. `null` for every row when no directory
   * is bound, or for a ref the directory didn't resolve.
   */
  private async withActorLabels<Row extends { actorRef: string }>(
    rows: Row[],
  ): Promise<(Row & WithActorLabel)[]> {
    if (rows.length === 0) {
      return [];
    }
    if (this.actorDirectory === undefined) {
      return rows.map((row) => ({ ...row, actorLabel: null }));
    }
    const refs = [...new Set(rows.map((row) => row.actorRef))];
    const resolved = await this.actorDirectory.resolveDisplay(refs);
    return rows.map((row) => ({ ...row, actorLabel: resolved[row.actorRef] ?? null }));
  }

  /** Current price row per model, for the pricing tab. 501s when no `AGENT_PRICING_STORE` is bound. */
  async listPrices(): Promise<CurrentModelPrice[]> {
    if (this.pricingStore === undefined) {
      throw new NotImplementedException(PRICING_STORE_UNBOUND_MESSAGE);
    }
    return this.pricingStore.listCurrentPrices();
  }

  /**
   * Set a model's current price (`POST <api>/pricing` body). 501s when no `AGENT_PRICING_STORE` is
   * bound (checked BEFORE body validation, so an unbound store always reports as unimplemented rather
   * than as a validation error); otherwise the body is minimally validated via {@link parsePriceInput}.
   */
  async upsertPrice(body: unknown): Promise<void> {
    if (this.pricingStore === undefined) {
      throw new NotImplementedException(PRICING_STORE_UNBOUND_MESSAGE);
    }
    await this.pricingStore.upsertModelPrice(parsePriceInput(body));
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
