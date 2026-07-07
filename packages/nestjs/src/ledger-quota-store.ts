import type { AgentStore, QuotaState, QuotaStore } from '@dudousxd/nestjs-agent-core';

/**
 * A production {@link QuotaStore} backed by the persisted usage ledger. `check` reads the actor's
 * tokens-so-far for the day straight from {@link AgentStore.quotaToday} and compares it to a fixed
 * daily limit; `bump` is a deliberate no-op because the loop's `recordUsage` already writes every
 * turn's tokens to that same ledger. One source of truth — so enforcement and what the dashboard
 * reports can never drift, and it works across replicas with no extra shared state.
 */
export class LedgerQuotaStore implements QuotaStore {
  constructor(
    private readonly store: AgentStore,
    private readonly limitTokens: number,
  ) {}

  async check(actorRef: string, day: string): Promise<QuotaState> {
    const { usedTokens } = await this.store.quotaToday(actorRef, day);
    return {
      usedTokens,
      limitTokens: this.limitTokens,
      withinLimit: usedTokens < this.limitTokens,
    };
  }

  async bump(): Promise<void> {
    // No-op: the ledger is the source of truth — recordUsage already persisted this turn's tokens.
  }
}
