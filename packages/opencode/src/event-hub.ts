import { Logger } from '@nestjs/common';
import type { OpenCodeClient, OpenCodeEvent } from './client.js';

type Listener = (event: OpenCodeEvent) => void;

interface Stream {
  client: OpenCodeClient;
  controller: AbortController;
  listeners: Map<string, Set<Listener>>;
  /**
   * Resolves once the server has sent the stream's first event (OpenCode opens every subscription
   * with `server.connected`), so a turn never prompts before the server can deliver the answer.
   */
  ready: Promise<void>;
}

/** The session an event belongs to. Form events carry it inside the form. */
export function sessionOf(event: OpenCodeEvent): string | undefined {
  const id = event.data?.sessionID ?? event.data?.form?.sessionID;
  return typeof id === 'string' ? id : undefined;
}

/** How long `listen` waits for a new stream's first event before it lets the turn go on anyway. */
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

/**
 * One event subscription per OpenCode server, fanned out to the turns listening on its sessions. A
 * server's stream closes when its last listener leaves; a stream that drops reconnects with backoff.
 *
 * `subscribe()` only describes the request: the client connects when the stream is first iterated,
 * and the server registers the subscriber some time after that. A stream is therefore open when its
 * first event arrives, not when it was asked for — events a prompt causes before then would be lost
 * (the catch-up recovers permissions and forms, not text, tools or the end of the execution).
 */
export class OpenCodeEventHub {
  private readonly logger = new Logger(OpenCodeEventHub.name);
  private readonly streams = new Map<string, Stream>();

  constructor(private readonly options: { connectTimeoutMs?: number } = {}) {}

  /**
   * Listen to one session's events on a server. Resolves once the server's stream is open (its first
   * event arrived), or after the connect timeout — the turn's safety nets cover a stream that is
   * slow to open.
   */
  async listen(
    serverKey: string,
    client: OpenCodeClient,
    sessionId: string,
    listener: Listener,
  ): Promise<() => void> {
    const stream = this.streamFor(serverKey, client);
    let set = stream.listeners.get(sessionId);
    if (set === undefined) {
      set = new Set();
      stream.listeners.set(sessionId, set);
    }
    set.add(listener);
    await stream.ready;
    return () => {
      // The server's stream now — it may have moved to a new client since this listener joined.
      const live = this.streams.get(serverKey) ?? stream;
      const current = live.listeners.get(sessionId);
      current?.delete(listener);
      if (current?.size === 0) live.listeners.delete(sessionId);
      if (live.listeners.size === 0 && this.streams.get(serverKey) === live) {
        live.controller.abort();
        this.streams.delete(serverKey);
      }
    };
  }

  close(): void {
    for (const stream of this.streams.values()) stream.controller.abort();
    this.streams.clear();
  }

  /**
   * The server's stream, opened on `client`. A different client for a known key (the host
   * replaced the connection, e.g. a new sandbox under the same key) moves every listener to a stream
   * on the new one: the old connection may be dead, and its sessions would never hear back.
   */
  private streamFor(serverKey: string, client: OpenCodeClient): Stream {
    const existing = this.streams.get(serverKey);
    if (existing !== undefined && existing.client === client) return existing;
    existing?.controller.abort();
    const controller = new AbortController();
    let opened!: () => void;
    const ready = new Promise<void>((resolve) => {
      opened = resolve;
    });
    const timeoutMs = this.options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    const timer = setTimeout(() => {
      this.logger.warn(`event stream of ${serverKey} not open after ${timeoutMs}ms; going on`);
      opened();
    }, timeoutMs);
    timer.unref?.();
    void ready.then(() => clearTimeout(timer));
    // A stream closed before it opened has nothing to wait for.
    controller.signal.addEventListener('abort', () => opened(), { once: true });
    const stream: Stream = {
      client,
      controller,
      listeners: existing?.listeners ?? new Map(),
      ready,
    };
    this.streams.set(serverKey, stream);
    void this.pump(serverKey, stream, client, opened);
    return stream;
  }

  private async pump(
    serverKey: string,
    stream: Stream,
    client: OpenCodeClient,
    opened: () => void,
  ): Promise<void> {
    let backoff = 500;
    while (!stream.controller.signal.aborted) {
      try {
        const events = client.event.subscribe({ signal: stream.controller.signal });
        for await (const event of events) {
          // The first event (`server.connected`) says the server is delivering to this stream.
          opened();
          backoff = 500;
          const sessionId = sessionOf(event);
          if (sessionId === undefined) continue;
          for (const listener of stream.listeners.get(sessionId) ?? []) {
            try {
              listener(event);
            } catch (error) {
              this.logger.error(`listener failed: ${(error as Error).message}`);
            }
          }
        }
      } catch (error) {
        if (stream.controller.signal.aborted) return;
        this.logger.warn(`event stream of ${serverKey} dropped: ${(error as Error).message}`);
      }
      if (stream.controller.signal.aborted) return;
      await new Promise((resolve) => setTimeout(resolve, backoff).unref?.());
      backoff = Math.min(backoff * 2, 10_000);
    }
  }
}
