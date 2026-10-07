import type { ChannelStore } from './spi/channel-store.js';

/**
 * Process-local {@link ChannelStore}: a single replica, tests, development. Keeps at most
 * `maxEntries` live keys; past that the oldest writes are forgotten first.
 */
export class InMemoryChannelStore implements ChannelStore {
  readonly #entries = new Map<string, { value: string | null; expiresAt: number }>();

  constructor(private readonly maxEntries = 50_000) {}

  #live(key: string) {
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt > Date.now()) return entry;
    this.#entries.delete(key);
    return undefined;
  }

  #put(key: string, value: string | null, ttlMs: number) {
    const now = Date.now();
    this.#entries.delete(key);
    this.#entries.set(key, { value, expiresAt: now + ttlMs });
    if (this.#entries.size <= this.maxEntries) return;
    // Insertion order is write order: the first keys are the oldest.
    for (const [stored, entry] of this.#entries) {
      if (this.#entries.size <= this.maxEntries && entry.expiresAt > now) break;
      this.#entries.delete(stored);
    }
  }

  async claim(key: string, ttlMs: number): Promise<boolean> {
    if (this.#live(key) !== undefined) return false;
    this.#put(key, null, ttlMs);
    return true;
  }

  async get(key: string): Promise<string | null> {
    return this.#live(key)?.value ?? null;
  }

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    this.#put(key, value, ttlMs);
  }

  async delete(key: string): Promise<void> {
    this.#entries.delete(key);
  }

  async purgeExpired(now: number = Date.now()): Promise<number> {
    let purged = 0;
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAt <= now) {
        this.#entries.delete(key);
        purged += 1;
      }
    }
    return purged;
  }
}
