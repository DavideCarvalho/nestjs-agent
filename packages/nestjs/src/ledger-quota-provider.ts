import {
  type AgentStore,
  type QuotaPeriod,
  type QuotaProvider,
  type QuotaQuery,
  type QuotaReport,
  type QuotaStore,
  type QuotaWindow,
  exhaustedWindow,
  quotaPeriodRange,
} from '@dudousxd/nestjs-agent-core';

/** Ceilings for a {@link LedgerQuotaProvider} window. Either, both, or neither. */
export interface QuotaWindowLimits {
  tokens?: number;
  usd?: number;
}

/** Per-window ceilings: `AgentModule.forRoot({ quotaLimits })`. */
export interface QuotaLimits {
  day?: QuotaWindowLimits;
  month?: QuotaWindowLimits;
}

/**
 * The default {@link QuotaProvider}: windows read off the usage ledger the loop already writes.
 *
 * - `day` — always; `usedTokens`/limit come from the bound {@link QuotaStore} when there is one (so
 *   the report matches what the loop enforces), spend from the ledger.
 * - `month` — when the store implements `usageBetween`.
 *
 * `limits` add ceilings per window (tokens and/or USD). A window that reaches one makes the report
 * `blocked`.
 */
export class LedgerQuotaProvider implements QuotaProvider {
  constructor(
    private readonly store: AgentStore,
    private readonly quota?: QuotaStore,
    private readonly limits: QuotaLimits = {},
  ) {}

  async report(query: QuotaQuery): Promise<QuotaReport> {
    const now = query.now ?? new Date();
    const actorRef = query.actor.id;
    const windows: QuotaWindow[] = [await this.dayWindow(actorRef, now)];
    if (this.store.usageBetween !== undefined) {
      const range = quotaPeriodRange('month', now);
      const used = await this.store.usageBetween(actorRef, range.fromDay, range.toDay);
      windows.push(this.window('month', used.usedTokens, used.costUsd, range.resetsAt));
    }
    const blocked = exhaustedWindow(windows);
    return { windows, ...(blocked !== undefined ? { blocked } : {}) };
  }

  private async dayWindow(actorRef: string, now: Date): Promise<QuotaWindow> {
    const range = quotaPeriodRange('day', now);
    const { usedTokens, costUsd } = await this.store.quotaToday(actorRef, range.fromDay);
    if (this.quota === undefined) {
      return this.window('day', usedTokens, costUsd, range.resetsAt);
    }
    const state = await this.quota.check(actorRef, range.fromDay);
    const window = this.window('day', state.usedTokens, costUsd, range.resetsAt);
    // The configured `quotaLimits.day.tokens` wins; otherwise the store's own ceiling.
    if (window.limitTokens === undefined) {
      window.limitTokens = state.limitTokens;
    }
    return window;
  }

  private window(
    period: QuotaPeriod,
    usedTokens: number,
    usedUsd: number,
    resetsAt: string,
  ): QuotaWindow {
    const limits = this.limits[period] ?? {};
    return {
      period,
      usedTokens,
      ...(limits.tokens !== undefined ? { limitTokens: limits.tokens } : {}),
      usedUsd,
      ...(limits.usd !== undefined ? { limitUsd: limits.usd } : {}),
      resetsAt,
    };
  }
}
