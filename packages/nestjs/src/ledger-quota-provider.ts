import {
  type AgentStore,
  type QuotaPeriod,
  type QuotaProvider,
  type QuotaQuery,
  type QuotaReport,
  type QuotaWindow,
  type UsageTotals,
  exhaustedWindow,
  quotaPeriodRange,
  quotaWarning,
} from '@dudousxd/nestjs-agent-core';

/** Ceilings for a {@link LedgerQuotaProvider} window. Either, both, or neither. */
export interface QuotaWindowLimits {
  tokens?: number;
  usd?: number;
}

/** Per-window ceilings: `AgentModule.forRoot({ quota: { limits } })`. */
export interface QuotaLimits {
  day?: QuotaWindowLimits;
  month?: QuotaWindowLimits;
}

/** {@link LedgerQuotaProvider}'s tuning beyond the ceilings. */
export interface LedgerQuotaOptions {
  /**
   * The soft limit: the share of a ceiling (`0..1`) past which the report carries a `warning`.
   * Stamped on every window that has a ceiling. Omit → no warnings.
   */
  warnAt?: number;
  /**
   * Whether the USD windows count ESTIMATED cost (tokens × the price row, for a provider that reports
   * none, e.g. Bedrock, OpenAI or Anthropic direct) as well as provider-reported cost. Default `true`:
   * a USD ceiling that ignored estimates would read $0 and never block for every such provider, which
   * is a budget that does not enforce. Set `false` to budget on provider-reported (gateway) cost only.
   */
  countEstimatedCost?: boolean;
}

/**
 * The default {@link QuotaProvider}: windows read off the usage ledger the loop already writes.
 *
 * - `day` — always.
 * - `month` — when the store implements `usageBetween` or `usageWindows`.
 *
 * `limits` add ceilings per window (tokens and/or USD). A window that reaches one makes the report
 * `blocked`.
 */
export class LedgerQuotaProvider implements QuotaProvider {
  constructor(
    private readonly store: AgentStore,
    private readonly limits: QuotaLimits = {},
    private readonly options: LedgerQuotaOptions = {},
  ) {}

  async report(query: QuotaQuery): Promise<QuotaReport> {
    const now = query.now ?? new Date();
    const actorRef = query.actor.id;
    const day = quotaPeriodRange('day', now);
    const month = quotaPeriodRange('month', now);
    const windows: QuotaWindow[] = [];
    if (this.store.usageWindows !== undefined) {
      const [dayUsed, monthUsed] = await this.store.usageWindows(actorRef, [day, month]);
      windows.push(this.usedWindow('day', dayUsed, day.resetsAt));
      windows.push(this.usedWindow('month', monthUsed, month.resetsAt));
    } else {
      windows.push(
        this.usedWindow('day', await this.store.quotaToday(actorRef, day.fromDay), day.resetsAt),
      );
      if (this.store.usageBetween !== undefined) {
        const used = await this.store.usageBetween(actorRef, month.fromDay, month.toDay);
        windows.push(this.usedWindow('month', used, month.resetsAt));
      }
    }
    const blocked = exhaustedWindow(windows);
    const warning = quotaWarning(windows);
    return {
      windows,
      ...(blocked !== undefined ? { blocked } : {}),
      ...(warning !== undefined ? { warning } : {}),
    };
  }

  private usedWindow(
    period: QuotaPeriod,
    used: UsageTotals | undefined,
    resetsAt: string,
  ): QuotaWindow {
    return this.window(
      period,
      used?.usedTokens ?? 0,
      used === undefined ? 0 : this.usd(used),
      resetsAt,
    );
  }

  /** The window's USD: every priced row, or (with `countEstimatedCost: false`) reported cost only. */
  private usd(used: UsageTotals): number {
    if (this.options.countEstimatedCost === false) {
      return Math.max(0, used.costUsd - (used.estimatedCostUsd ?? 0));
    }
    return used.costUsd;
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
      ...(this.options.warnAt !== undefined &&
      (limits.tokens !== undefined || limits.usd !== undefined)
        ? { warnAt: this.options.warnAt }
        : {}),
    };
  }
}
