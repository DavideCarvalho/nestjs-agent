import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import type {
  ActorSpendRow,
  AgentApprovalPort,
  AgentGovernanceQueries,
  AgentPricingStore,
  ApprovalWhere,
  CurrentModelPrice,
  GovernancePage,
  GovernancePageQuery,
  GovernanceRange,
  GovernanceRunDetail,
  GovernanceThreadDetail,
  GovernanceThreadDetailQuery,
  ModelSpendRow,
  PendingApprovalRow,
  RecentRunRow,
  RunAgentBreakdownRow,
  RunErrorBreakdownRow,
  RunMetrics,
  RunTrendPoint,
  RunWhere,
  ThreadActivityRow,
  ThreadSpendRow,
  ThreadWhere,
  ToolCallActivityRow,
  ToolCallWhere,
  ToolStatRow,
  UsageTrendPoint,
} from '@dudousxd/nestjs-agent-core';
import { channelName } from '@dudousxd/nestjs-diagnostics';
import {
  Inject,
  Injectable,
  NotFoundException,
  NotImplementedException,
  Optional,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import type { ActorDirectory } from './actor-directory.js';
import { parseApprovalDecision } from './parse-approval-decision.js';
import { parsePriceInput } from './parse-price-input.js';
import {
  AGENT_ACTOR_DIRECTORY,
  AGENT_APPROVAL_PORT,
  AGENT_GOVERNANCE_QUERIES,
  AGENT_PRICING_STORE,
} from './tokens.js';

/** An actor-scoped row decorated with its resolved display label — `null` when unbound or unresolved. */
export interface WithActorLabel {
  actorLabel: string | null;
}

export type ActorSpendRowWithLabel = ActorSpendRow & WithActorLabel;
export type ThreadSpendRowWithLabel = ThreadSpendRow & WithActorLabel;
export type ThreadActivityRowWithLabel = ThreadActivityRow & WithActorLabel;

/**
 * `GET <api>/runs/:runId` — a run drill-down with the owning thread's `actorLabel` resolved, the
 * same way {@link threadsPage} labels its rows. The run row itself stays unlabeled, matching every
 * other run surface in this console.
 */
export type RunDetailWithLabel = Omit<GovernanceRunDetail, 'thread'> & {
  thread: GovernanceRunDetail['thread'] & WithActorLabel;
};

/** `GET <api>/threads/:threadId` — a thread drill-down, actor-labeled like {@link threadsPage}. */
export type ThreadDetailWithLabel = Omit<GovernanceThreadDetail, 'thread'> & {
  thread: ThreadActivityRowWithLabel;
};

/** The spend/usage overview the SPA renders on its headline section (`GET <api>/spend`). */
export interface SpendOverview {
  byModel: ModelSpendRow[];
  byActor: ActorSpendRowWithLabel[];
  trend: UsageTrendPoint[];
}

/** The run-reliability overview the SPA renders on its Reliability section (`GET <api>/reliability`). */
export interface ReliabilityOverview {
  metrics: RunMetrics;
  byAgent: RunAgentBreakdownRow[];
  errors: RunErrorBreakdownRow[];
  trend: RunTrendPoint[];
}

/** The message returned as a 501 when no `AGENT_PRICING_STORE` is bound. */
const PRICING_STORE_UNBOUND_MESSAGE =
  'Pricing CRUD is unavailable: no AGENT_PRICING_STORE is bound. Bind a pricing store (e.g. ' +
  'MikroOrmPricingStore from @dudousxd/nestjs-agent-store-mikro-orm) to enable it.';

/** The message returned as a 501 when no `AGENT_APPROVAL_PORT` is bound. */
const APPROVAL_PORT_UNBOUND_MESSAGE =
  'Approve/reject is unavailable: no AGENT_APPROVAL_PORT is bound. Import AgentModule from ' +
  '@dudousxd/nestjs-agent alongside this dashboard to enable it — the approvals inbox stays ' +
  'read-only until then.';

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
    @Optional()
    @Inject(AGENT_APPROVAL_PORT)
    private readonly approvalPort?: AgentApprovalPort,
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

  /** Run reliability for a day range: metrics, by-agent/by-error breakdowns and the trend, in parallel. */
  async reliability(range: GovernanceRange): Promise<ReliabilityOverview> {
    const [metrics, byAgent, errors, trend] = await Promise.all([
      this.queries.runMetrics(range),
      this.queries.runsByAgent(range),
      this.queries.runErrors(range),
      this.queries.runTrend(range),
    ]);
    return { metrics, byAgent, errors, trend };
  }

  /** Most recent runs (status/agent/duration/error) for the Reliability recent-runs table. */
  recentRuns(limit: number): Promise<RecentRunRow[]> {
    return this.queries.recentRuns(limit);
  }

  /** Most recent tool calls (status/type/thread) for the Runs & tools activity feed. */
  recentToolCalls(limit: number): Promise<ToolCallActivityRow[]> {
    return this.queries.recentToolCalls(limit);
  }

  /** Paged, filterable tool calls for the Runs & tools activity table. */
  toolCallsPage(
    query: GovernancePageQuery<ToolCallWhere>,
  ): Promise<GovernancePage<ToolCallActivityRow>> {
    return this.queries.toolCallsPage(query);
  }

  /** Paged, filterable runs for the Reliability recent-runs table. */
  runsPage(query: GovernancePageQuery<RunWhere>): Promise<GovernancePage<RecentRunRow>> {
    return this.queries.runsPage(query);
  }

  /**
   * Tool calls sitting `pending_approval`, oldest first, for the cross-thread approvals inbox.
   * Capped and totalless — kept because the SPA still calls `GET approvals`; new callers want
   * {@link approvalsPage}, which reports how much of the backlog the cap hid.
   */
  pendingApprovals(limit: number): Promise<PendingApprovalRow[]> {
    return this.queries.pendingApprovals(limit);
  }

  /** Paged, filterable approvals inbox with a total — the backlog-safe read of the HITL queue. */
  approvalsPage(
    query: GovernancePageQuery<ApprovalWhere>,
  ): Promise<GovernancePage<PendingApprovalRow>> {
    return this.queries.approvalsPage(query);
  }

  /**
   * One run with its thread and its tool calls. 404s on an unknown id rather than returning an empty
   * detail: "this run does not exist" and "this run did nothing" are different answers, and a console
   * that conflates them sends an operator looking for a bug that isn't there.
   */
  async runDetail(runId: string): Promise<RunDetailWithLabel> {
    const detail = await this.queries.runDetail(runId);
    if (detail === null) {
      throw new NotFoundException(`No run "${runId}".`);
    }
    const [thread] = await this.withActorLabels([detail.thread]);
    // `withActorLabels` returns one row per input; the array is never empty here.
    return { ...detail, thread: thread ?? { ...detail.thread, actorLabel: null } };
  }

  /** One thread with its usage rollup, runs and messages. 404s on an unknown id, like {@link runDetail}. */
  async threadDetail(query: GovernanceThreadDetailQuery): Promise<ThreadDetailWithLabel> {
    const detail = await this.queries.threadDetail(query);
    if (detail === null) {
      throw new NotFoundException(`No thread "${query.threadId}".`);
    }
    const [thread] = await this.withActorLabels([detail.thread]);
    return { ...detail, thread: thread ?? { ...detail.thread, actorLabel: null } };
  }

  /** Per-tool call/failure/rejection/latency rollup for a day range, for the Tools section. */
  toolStats(range: GovernanceRange): Promise<ToolStatRow[]> {
    return this.queries.toolStats(range);
  }

  /**
   * Decide a pending HITL tool call from the console. Routes through the OPTIONAL
   * {@link AGENT_APPROVAL_PORT} — bound by `@dudousxd/nestjs-agent` to the SAME signal path chat
   * approvals use — so a 501 here (checked BEFORE body validation, same ordering as
   * {@link upsertPrice}) means "no approval port bound", not "your body was invalid". `executedByRef`
   * is an OPAQUE decider ref the caller resolved from the live request (see
   * `AgentDashboardOptions.approvalActorRef`); omitted when the host didn't configure one.
   */
  async decideApproval(
    toolCallId: string,
    body: unknown,
    executedByRef: string | undefined,
  ): Promise<void> {
    if (this.approvalPort === undefined) {
      throw new NotImplementedException(APPROVAL_PORT_UNBOUND_MESSAGE);
    }
    const decision = parseApprovalDecision(body);
    const opts = executedByRef !== undefined ? { executedByRef } : {};
    if (decision.approved) {
      await this.approvalPort.approve(toolCallId, opts);
      return;
    }
    await this.approvalPort.reject(toolCallId, {
      ...opts,
      ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
    });
  }

  /** Most recent threads with rolled-up message/token counts. */
  async recentThreads(limit: number): Promise<ThreadActivityRowWithLabel[]> {
    const rows = await this.queries.recentThreads(limit);
    return this.withActorLabels(rows);
  }

  /**
   * Paged, filterable threads for the Runs & tools threads table — actor-labeled the same way
   * {@link recentThreads} is.
   */
  async threadsPage(
    query: GovernancePageQuery<ThreadWhere>,
  ): Promise<GovernancePage<ThreadActivityRowWithLabel>> {
    const page = await this.queries.threadsPage(query);
    const rows = await this.withActorLabels(page.rows);
    return { ...page, rows };
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
