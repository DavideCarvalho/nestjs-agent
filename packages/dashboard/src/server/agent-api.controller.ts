import type { ThreadActivityRow, ToolCallActivityRow } from '@dudousxd/nestjs-agent-core';
import { Controller, Get, Query, Sse } from '@nestjs/common';
import type { Observable } from 'rxjs';
import { DashboardService, type LiveAgentEvent, type SpendOverview } from './dashboard.service.js';

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
  constructor(private readonly dashboard: DashboardService) {}

  /** `{ byModel, byActor, trend }` for a day range (defaults to the last 30 days). */
  @Get('spend')
  spend(@Query('from') from?: string, @Query('to') to?: string): Promise<SpendOverview> {
    return this.dashboard.spend(resolveRange(from, to));
  }

  /** Most recent tool calls (default 50, max 200) for the activity feed. */
  @Get('tool-calls')
  toolCalls(@Query('limit') limit?: string): Promise<ToolCallActivityRow[]> {
    return this.dashboard.recentToolCalls(parseLimit(limit, 50));
  }

  /** Most recent threads (default 50, max 200) with rolled-up counts. */
  @Get('threads')
  threads(@Query('limit') limit?: string): Promise<ThreadActivityRow[]> {
    return this.dashboard.recentThreads(parseLimit(limit, 50));
  }

  /** Server-Sent Events stream of live `aviary:agent:*` events — the Live feed tails it. */
  @Sse('stream')
  stream(): Observable<{ data: LiveAgentEvent }> {
    return this.dashboard.streamEvents();
  }
}
