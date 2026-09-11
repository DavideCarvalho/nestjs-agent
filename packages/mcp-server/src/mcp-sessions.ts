import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Injectable, type OnApplicationShutdown } from '@nestjs/common';

/** One live MCP session: its transport, and the actor it was opened by. */
export interface McpSession {
  transport: StreamableHTTPServerTransport;
  /**
   * The id of the actor that initialized this session. Every later request on it must authenticate
   * as the same actor — a session id travels in a plain header, and the session holds an open SSE
   * stream that server messages are written to, so a second caller adopting it would be reading a
   * stream opened for somebody else.
   */
  actorId: string;
}

/**
 * The MCP sessions this process is holding, keyed by session id.
 *
 * In-memory and therefore per-pod: a fleet behind a load balancer needs session affinity on the MCP
 * route, or a client's second request lands on a pod that never saw its `initialize` and is told to
 * start again.
 */
@Injectable()
export class McpSessionStore implements OnApplicationShutdown {
  private readonly sessions = new Map<string, McpSession>();

  get(sessionId: string): McpSession | undefined {
    return this.sessions.get(sessionId);
  }

  open(input: { sessionId: string; session: McpSession }): void {
    this.sessions.set(input.sessionId, input.session);
  }

  close(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /** How many sessions are live. Reported by the module's specs; useful to a host's health check. */
  get size(): number {
    return this.sessions.size;
  }

  async onApplicationShutdown(): Promise<void> {
    const live = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(live.map((session) => session.transport.close()));
  }
}
