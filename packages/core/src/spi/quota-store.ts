import type { QuotaState } from '../types.js';

/**
 * Per-actor/day token budget. `check` reports the day's usage against the limit before a turn;
 * `bump` accounts a turn's tokens after it. Two impls ship: `InMemoryQuotaStore` (testing/offline)
 * and the production `LedgerQuotaStore` (nestjs) which reads the persisted usage ledger — set
 * `AgentModule.forRoot({ quotaLimitTokens })` to bind it, or supply your own for a bespoke budget.
 */
export interface QuotaStore {
  check(actorRef: string, day: string): Promise<QuotaState>;
  /** Account a turn's tokens. A no-op for ledger-backed stores, which read `recordUsage` directly. */
  bump(actorRef: string, day: string, tokens: number): Promise<void>;
}
