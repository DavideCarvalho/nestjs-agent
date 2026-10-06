import { Logger } from '@nestjs/common';
import type { OpenCodeClient, OpenCodeEvent } from './client.js';

type Listener = (event: OpenCodeEvent) => void;

interface Stream {
  controller: AbortController;
  listeners: Map<string, Set<Listener>>;
  /** Resolves once the subscription is open, so a turn never prompts before it can hear the answer. */
  ready: Promise<void>;
}

/** The session an event belongs to. Form events carry it inside the form. */
export function sessionOf(event: OpenCodeEvent): string | undefined {
  const id = event.data?.sessionID ?? event.data?.form?.sessionID;
  return typeof id === 'string' ? id : undefined;
}

/**
 * One event subscription per OpenCode server, fanned out to the turns listening on its sessions. A
 * server's stream closes when its last listener leaves; a stream that drops reconnects with backoff.
 */
export class OpenCodeEventHub {
  private readonly logger = new Logger(OpenCodeEventHub.name);
  private readonly streams = new Map<string, Stream>();

  /** Listen to one session's events on a server. Resolves once the server's stream is open. */
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
      const current = stream.listeners.get(sessionId);
      current?.delete(listener);
      if (current?.size === 0) stream.listeners.delete(sessionId);
      if (stream.listeners.size === 0 && this.streams.get(serverKey) === stream) {
        stream.controller.abort();
        this.streams.delete(serverKey);
      }
    };
  }

  close(): void {
    for (const stream of this.streams.values()) stream.controller.abort();
    this.streams.clear();
  }

  private streamFor(serverKey: string, client: OpenCodeClient): Stream {
    const existing = this.streams.get(serverKey);
    if (existing !== undefined) return existing;
    const controller = new AbortController();
    let opened!: () => void;
    const ready = new Promise<void>((resolve) => {
      opened = resolve;
    });
    const stream: Stream = { controller, listeners: new Map(), ready };
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
        opened();
        for await (const event of events) {
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
