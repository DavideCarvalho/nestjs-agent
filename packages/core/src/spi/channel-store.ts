/**
 * Short-lived state of a text channel (WhatsApp, Telegram, …), every entry with a TTL: the provider
 * message ids already taken (so a webhook delivered twice starts one turn), a question waiting for
 * the person's answer, an outcome already relayed. Used by `@dudousxd/nestjs-agent-channels`.
 *
 * {@link import('../channel-store.js').InMemoryChannelStore} only sees its own process. With several
 * replicas a retry, an answer or a settled proposal can land on another one, so use a shared store
 * there: `DrizzleChannelStore` / `MikroOrmChannelStore` (bound to `AGENT_CHANNEL_STORE` by the store
 * modules, on the `agent_channel_state` table), `RedisChannelStore`
 * (`@dudousxd/nestjs-agent-transport-redis`), or your own.
 */
export interface ChannelStore {
  /**
   * Take `key` for `ttlMs` — atomically. `true` when it was free (now taken), `false` when someone
   * already took it. An expired key is free again.
   */
  claim(key: string, ttlMs: number): Promise<boolean>;
  /** The live value under `key`, or `null` (also for a key that was only claimed). */
  get(key: string): Promise<string | null>;
  /** Store `value` under `key` for `ttlMs`, replacing what was there. */
  set(key: string, value: string, ttlMs: number): Promise<void>;
  delete(key: string): Promise<void>;
  /** Drop the entries that expired before `now` (epoch-ms, default the clock). Returns how many. */
  purgeExpired?(now?: number): Promise<number>;
}
