import type { QuotaState, QuotaStore } from '@dudousxd/nestjs-agent-core';

/** In-memory per-actor/day token budget for tests and the offline demo. */
export class InMemoryQuotaStore implements QuotaStore {
  private readonly used = new Map<string, number>();

  constructor(private readonly limitTokens = 1_000_000) {}

  private key(actorRef: string, day: string): string {
    return `${actorRef}:${day}`;
  }

  async check(actorRef: string, day: string): Promise<QuotaState> {
    const usedTokens = this.used.get(this.key(actorRef, day)) ?? 0;
    return {
      usedTokens,
      limitTokens: this.limitTokens,
      withinLimit: usedTokens < this.limitTokens,
    };
  }

  async bump(actorRef: string, day: string, tokens: number): Promise<void> {
    const key = this.key(actorRef, day);
    this.used.set(key, (this.used.get(key) ?? 0) + tokens);
  }
}
