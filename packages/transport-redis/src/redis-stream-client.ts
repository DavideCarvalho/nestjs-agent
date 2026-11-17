/**
 * The minimal Redis surface {@link import('./redis-token-stream-sink.js').RedisTokenStreamSink}
 * needs. The host adapts its own `ioredis` / `node-redis` client to this — so this package pulls in
 * NO Redis driver of its own (bring your own, exactly like the store adapters take an ORM handle).
 *
 * NOTE: `subscribe` needs a connection in subscriber mode; most drivers require a DEDICATED
 * connection for that (a subscribed client can't run other commands). Pass a separate client for
 * `subscribe` if your driver enforces it — the sink only calls `subscribe` from `subscribe()`.
 */
export interface RedisStreamClient {
  /**
   * Append `value` to the list at `key` (RPUSH), resolving to the list's new length — what RPUSH
   * replies, and what `ioredis` / `node-redis` resolve to as is. The length numbers each frame, so
   * the sink can carry frames in their `PUBLISH` and live subscribers skip the `LRANGE`. An adapter
   * that resolves to nothing still works: its frames are published as a bare wake and read back
   * with `LRANGE`, the way they were before.
   */
  // biome-ignore lint/suspicious/noConfusingVoidType: adapters typed `Promise<void>` must still type-check.
  rpush(key: string, value: string): Promise<number | void>;
  /** The list elements at `key` from `start` to `stop` inclusive; negative indices count from the end (LRANGE). */
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  /** Set `key` to `value` (SET) — used for the terminal marker. */
  set(key: string, value: string): Promise<void>;
  /** The value at `key`, or `null` if unset (GET). */
  get(key: string): Promise<string | null>;
  /** Publish `message` on `channel` (PUBLISH). */
  publish(channel: string, message: string): Promise<void>;
  /** Subscribe to `channel`, invoking `onMessage` per message. Resolves to an unsubscribe function. */
  subscribe(channel: string, onMessage: (message: string) => void): Promise<() => Promise<void>>;
  /** Delete the given keys (DEL). */
  del(...keys: string[]): Promise<void>;
  /**
   * Expire `key` after `seconds` (EXPIRE) — how a run's keys stop outliving their replay window.
   * An adapter written before this existed still runs, but its keys never expire.
   */
  expire(key: string, seconds: number): Promise<void>;
}
