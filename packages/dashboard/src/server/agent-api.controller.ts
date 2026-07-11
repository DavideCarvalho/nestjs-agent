import type {
  CurrentModelPrice,
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
  type SpendOverview,
  type ThreadActivityRowWithLabel,
  type ThreadSpendRowWithLabel,
} from './dashboard.service.js';
import { DASHBOARD_APPROVAL_ACTOR_REF } from './tokens.js';

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

/** Parse a `limit` query param, clamped to a sane window; falls back to `fallback` when absent/junk. */
function parseLimit(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? Number.NaN : Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(200, parsed));
}

/**
 * JSON + SSE API consumed by the AI-gateway console SPA. Mounted at `apiBasePath` (set by
 * `RouterModule` in {@link AgentDashboardModule.forRoot}), so the controller routes are relative.
 */
@Controller()
export class AgentApiController {
  constructor(
    private readonly dashboard: DashboardService,
    // `useValue` even when the host omitted `approvalActorRef` — no `@Optional()` needed (the token
    // is always bound; see DASHBOARD_APPROVAL_ACTOR_REF's TSDoc).
    @Inject(DASHBOARD_APPROVAL_ACTOR_REF)
    private readonly approvalActorRef: ((req: unknown) => string | undefined) | undefined,
  ) {}

  /** `{ byModel, byActor, trend }` for a day range (defaults to the last 30 days). */
  @Get('spend')
  spend(@Query('from') from?: string, @Query('to') to?: string): Promise<SpendOverview> {
    return this.dashboard.spend(resolveRange(from, to));
  }

  /** Top threads by cost (default 10, max 200) for a day range (defaults to the last 30 days). */
  @Get('top-threads')
  topThreads(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
  ): Promise<ThreadSpendRowWithLabel[]> {
    return this.dashboard.topThreads(resolveRange(from, to), parseLimit(limit, 10));
  }

  /** `{ metrics, byAgent, errors, trend }` for a day range (defaults to the last 30 days). */
  @Get('reliability')
  reliability(
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<ReliabilityOverview> {
    return this.dashboard.reliability(resolveRange(from, to));
  }

  /** Most recent runs (default 50, max 200) for the Reliability recent-runs table. */
  @Get('runs')
  runs(@Query('limit') limit?: string): Promise<RecentRunRow[]> {
    return this.dashboard.recentRuns(parseLimit(limit, 50));
  }

  /** Most recent tool calls (default 50, max 200) for the activity feed. */
  @Get('tool-calls')
  toolCalls(@Query('limit') limit?: string): Promise<ToolCallActivityRow[]> {
    return this.dashboard.recentToolCalls(parseLimit(limit, 50));
  }

  /** Tool calls sitting `pending_approval` (default 50, max 200), oldest first — the approvals inbox. */
  @Get('approvals')
  approvals(@Query('limit') limit?: string): Promise<PendingApprovalRow[]> {
    return this.dashboard.pendingApprovals(parseLimit(limit, 50));
  }

  /**
   * Decide a pending HITL tool call. Body `{ approved: boolean; reason?: string }`. 501s (via
   * `DashboardService.decideApproval`) when no `AGENT_APPROVAL_PORT` is bound. `executedByRef`
   * comes from the host's `approvalActorRef` extractor run against the live request, when configured.
   */
  @Post('approvals/:toolCallId')
  @HttpCode(204)
  async decideApproval(
    @Param('toolCallId') toolCallId: string,
    @Body() body: unknown,
    @Req() req: unknown,
  ): Promise<void> {
    await this.dashboard.decideApproval(toolCallId, body, this.approvalActorRef?.(req));
  }

  /** Per-tool call/failure/rejection/latency rollup for a day range (defaults to the last 30 days). */
  @Get('tools')
  tools(@Query('from') from?: string, @Query('to') to?: string): Promise<ToolStatRow[]> {
    return this.dashboard.toolStats(resolveRange(from, to));
  }

  /** Most recent threads (default 50, max 200) with rolled-up counts. */
  @Get('threads')
  threads(@Query('limit') limit?: string): Promise<ThreadActivityRowWithLabel[]> {
    return this.dashboard.recentThreads(parseLimit(limit, 50));
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
