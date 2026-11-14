import { CanAnyone } from '@dudousxd/nestjs-agent-core';
import type {
  ActorResolver,
  CurrentModelPrice,
  GenuiStats,
  PendingApprovalRow,
  RecentRunRow,
  ToolCallActivityRow,
  ToolStatRow,
} from '@dudousxd/nestjs-agent-core';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Optional,
  Param,
  Post,
  Query,
  Req,
  Sse,
} from '@nestjs/common';
import type { Observable } from 'rxjs';
import {
  DashboardService,
  type LiveAgentEvent,
  type ReliabilityOverview,
  type RunDetailWithLabel,
  type SpendOverview,
  type ThreadActivityRowWithLabel,
  type ThreadDetailWithLabel,
  type ThreadSpendRowWithLabel,
} from './dashboard.service.js';
import type { OffsetPage } from './list-api.js';
import {
  parseApprovalsQuery,
  parseRunsQuery,
  parseThreadsQuery,
  parseToolCallsQuery,
  parseTopSize,
  toListPage,
} from './parse-list-query.js';
import type { ConsoleTenancy } from './tenancy.js';
import { AGENT_ACTOR_RESOLVER, DASHBOARD_APPROVAL_ACTOR_REF } from './tokens.js';

const DAY_MS = 86_400_000;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A `YYYY-MM-DD` UTC day string `daysAgo` days before now (0 = today). */
function utcDay(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * DAY_MS).toISOString().slice(0, 10);
}

/** Accept a client-supplied `YYYY-MM-DD`, or fall back to `fallback`; guards against junk input. */
function dayOr(value: string | undefined, fallback: string): string {
  return value !== undefined && ISO_DAY.test(value) ? value : fallback;
}

/** Resolve the `from`/`to` query params into a validated range, defaulting to the last 30 days. */
function resolveRange(
  from: string | undefined,
  to: string | undefined,
): {
  fromDay: string;
  toDay: string;
} {
  return { fromDay: dayOr(from, utcDay(29)), toDay: dayOr(to, utcDay(0)) };
}

/**
 * Parse one of the thread drill-down's row caps (`messages`, `runs`), clamped to a sane window;
 * falls back to `fallback` when absent/junk.
 */
function parseCap(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? Number.NaN : Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(200, parsed));
}

/**
 * JSON + SSE API consumed by the AI-gateway console SPA. Mounted at `apiBasePath` (set by
 * `RouterModule` in {@link AgentDashboardModule.forRoot}), so the controller routes are relative.
 *
 * Who reaches it: `authorize` on `AgentDashboardModule.forRoot` (checked by `ConsoleAuthorizeGuard`,
 * after the app's `decorators`). Mounted by the app itself (`routes: false`), apply
 * `UseConsoleAuthorize()` to your subclass.
 */
@CanAnyone()
@Controller()
export class AgentApiController {
  constructor(
    private readonly dashboard: DashboardService,
    // `useValue` even when the host omitted `approvalActorRef` — no `@Optional()` needed (the token
    // is always bound; see DASHBOARD_APPROVAL_ACTOR_REF's TSDoc).
    @Inject(DASHBOARD_APPROVAL_ACTOR_REF)
    private readonly approvalActorRef: ((req: unknown) => string | undefined) | undefined,
    // The app's identity seam, bound + exported by the (global) AgentModule — the DEFAULT decider
    // attribution when no `approvalActorRef` override is configured. Genuinely `@Optional()`: the
    // dashboard can be mounted without AgentModule (read-model only), where nothing binds it.
    @Optional()
    @Inject(AGENT_ACTOR_RESOLVER)
    private readonly actorResolver?: ActorResolver,
  ) {}

  /**
   * The Organization the console is scoped to: `{ enabled, scope, tenant, chain }`, each level with
   * its `label` (the app's `tenancy.label`, else slug, else id).
   */
  @Get('tenancy')
  tenancy(): Promise<ConsoleTenancy> {
    return this.dashboard.tenancy();
  }

  /** `{ byModel, byActor, trend }` for a day range (defaults to the last 30 days). */
  @Get('spend')
  spend(@Query('from') from?: string, @Query('to') to?: string): Promise<SpendOverview> {
    return this.dashboard.spend(resolveRange(from, to));
  }

  /**
   * Top threads by cost for a day range (defaults to the last 30 days) — a top-N widget, not a list:
   * `size` (default 10, max 200), answered as `{ data }`.
   */
  @Get('top-threads')
  async topThreads(
    @Query() query: Record<string, unknown>,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<{ data: ThreadSpendRowWithLabel[] }> {
    const size = parseTopSize(query, 10, ['from', 'to']);
    return { data: await this.dashboard.topThreads(resolveRange(from, to), size) };
  }

  /** `{ metrics, byAgent, errors, trend }` for a day range (defaults to the last 30 days). */
  @Get('reliability')
  reliability(
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<ReliabilityOverview> {
    return this.dashboard.reliability(resolveRange(from, to));
  }

  /**
   * Runs, newest first — the Reliability recent-runs table. Offset list: `page` (default 1), `size`
   * (default 25, max 200), `filter[agentName|status|errorCode|threadId|fromDay|toDay]` (days are
   * `YYYY-MM-DD`), `sort` only `-startedAt`. Answers `{ data, meta }`; an unknown filter field or
   * any other sort 400s.
   */
  @Get('runs')
  async runs(@Query() query: Record<string, unknown>): Promise<OffsetPage<RecentRunRow>> {
    return toListPage(await this.dashboard.runsPage(parseRunsQuery(query)));
  }

  /**
   * One run drill-down: the run, its owning thread's headline (actor-labeled) and its tool calls, in
   * ONE round trip. 404s on an unknown run id.
   */
  @Get('runs/:runId')
  runDetail(@Param('runId') runId: string): Promise<RunDetailWithLabel> {
    return this.dashboard.runDetail(runId);
  }

  /**
   * Tool calls, newest first — the activity feed and the Runs & tools table. Offset list: `page`,
   * `size` (default 25, max 200), `filter[toolName|toolType|status|threadId|fromDay|toDay]`, `sort`
   * only `-createdAt`. Answers `{ data, meta }`.
   */
  @Get('tool-calls')
  async toolCalls(
    @Query() query: Record<string, unknown>,
  ): Promise<OffsetPage<ToolCallActivityRow>> {
    return toListPage(await this.dashboard.toolCallsPage(parseToolCallsQuery(query)));
  }

  /**
   * The approvals inbox: tool calls sitting `pending_approval`, OLDEST first. Offset list: `page`,
   * `size` (default 25, max 200), `filter[toolName|threadId|actorRef|agentName|fromDay|toDay]`,
   * `sort` only `requestedAt`. Answers `{ data, meta }` — `meta.total` is the backlog size, so no
   * pending decision hides behind a row cap.
   */
  @Get('approvals')
  async approvals(
    @Query() query: Record<string, unknown>,
  ): Promise<OffsetPage<PendingApprovalRow>> {
    return toListPage(await this.dashboard.approvalsPage(parseApprovalsQuery(query)));
  }

  /**
   * Decide a pending HITL tool call. Body `{ approved: boolean; reason?: string }`. 501s (via
   * `DashboardService.decideApproval`) when no `AGENT_APPROVAL_PORT` is bound. `executedByRef`
   * comes from {@link deciderRef} run against the live request.
   */
  @Post('approvals/:toolCallId')
  @HttpCode(204)
  async decideApproval(
    @Param('toolCallId') toolCallId: string,
    @Body() body: unknown,
    @Req() req: unknown,
  ): Promise<void> {
    await this.dashboard.decideApproval(toolCallId, body, await this.deciderRef(req));
  }

  /**
   * WHO decided, as an opaque ref: an explicit `approvalActorRef` override wins outright (no
   * resolver fallback, even when it returns `undefined`); otherwise the AgentModule-configured
   * actor resolver — the same identity seam chat requests use. A resolver that throws is an
   * unauthenticated/unreadable request, not an error to surface: the decision itself was already
   * authorized by the dashboard's guards, so the ref is simply omitted.
   */
  private async deciderRef(req: unknown): Promise<string | undefined> {
    if (this.approvalActorRef !== undefined) {
      return this.approvalActorRef(req);
    }
    if (this.actorResolver === undefined) {
      return undefined;
    }
    try {
      return (await this.actorResolver.resolve(req)).id;
    } catch {
      return undefined;
    }
  }

  /** Per-tool call/failure/rejection/latency rollup for a day range (defaults to the last 30 days). */
  @Get('tools')
  tools(@Query('from') from?: string, @Query('to') to?: string): Promise<ToolStatRow[]> {
    return this.dashboard.toolStats(resolveRange(from, to));
  }

  /**
   * Generative-UI telemetry for a day range (defaults to the last 30 days): `{ totals, byToolModel,
   * errors, byDay, costPerTurn, latency }`. 501s (via `DashboardService.genuiStats`) when the bound
   * store does not implement `genuiStats`.
   */
  @Get('genui')
  genui(@Query('from') from?: string, @Query('to') to?: string): Promise<GenuiStats> {
    return this.dashboard.genuiStats(resolveRange(from, to));
  }

  /**
   * Threads with rolled-up counts, newest activity first — the Runs & tools threads table. Offset
   * list: `page`, `size` (default 25, max 200), `filter[actorRef|fromDay|toDay]`,
   * `filter[title][contains]` (case-insensitive substring), `sort` only `-lastActivityAt`. Answers
   * `{ data, meta }`.
   */
  @Get('threads')
  async threads(
    @Query() query: Record<string, unknown>,
  ): Promise<OffsetPage<ThreadActivityRowWithLabel>> {
    return toListPage(await this.dashboard.threadsPage(parseThreadsQuery(query)));
  }

  /**
   * One thread drill-down: the thread (actor-labeled), its lifetime token/cost rollup, its newest
   * runs and its newest messages, in ONE round trip. `messages` (default 50, max 200) and `runs`
   * (default 25, max 200) cap the two lists; `runTotal` and `thread.messageCount` report the true
   * sizes so the console can say what the caps hid. 404s on an unknown thread id.
   *
   * A soft-deleted thread is still returned, flagged `deleted: true` — an audit needs the thread it
   * just lost, and the alternative is a drill-down that 404s on exactly the interesting case.
   */
  @Get('threads/:threadId')
  threadDetail(
    @Param('threadId') threadId: string,
    @Query('messages') messages?: string,
    @Query('runs') runs?: string,
  ): Promise<ThreadDetailWithLabel> {
    return this.dashboard.threadDetail({
      threadId,
      messageLimit: parseCap(messages, 50),
      runLimit: parseCap(runs, 25),
    });
  }

  /**
   * Current price row per model, for the pricing tab. 501s (via `DashboardService.listPrices`) when
   * no `AGENT_PRICING_STORE` is bound.
   */
  @Get('pricing')
  listPrices(): Promise<CurrentModelPrice[]> {
    return this.dashboard.listPrices();
  }

  /**
   * Set a model's current price. Body shape mirrors core's `ModelPriceInput`
   * (`{ modelId, inputPricePer1m, outputPricePer1m, cacheWritePricePer1m?, cacheReadPricePer1m? }`).
   * 501s when no `AGENT_PRICING_STORE` is bound; 400s on a malformed body.
   */
  @Post('pricing')
  upsertPrice(@Body() body: unknown): Promise<void> {
    return this.dashboard.upsertPrice(body);
  }

  /** Server-Sent Events stream of live `aviary:agent:*` events — the Live feed tails it. */
  @Sse('stream')
  stream(): Observable<{ data: LiveAgentEvent }> {
    return this.dashboard.streamEvents();
  }
}
