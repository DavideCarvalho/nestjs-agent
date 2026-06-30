import type { QuotaState } from '../types.js';

/** Per-actor/day token budget. Default impl is in-memory; Redis impl ships in transport-redis. */
export interface QuotaStore {
  check(actorRef: string, day: string): Promise<QuotaState>;
  bump(actorRef: string, day: string, tokens: number): Promise<void>;
}
