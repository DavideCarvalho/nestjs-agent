import type { ThreadDetail, ThreadSummary } from '@dudousxd/nestjs-agent-core';

/**
 * Thrown by {@link AgentClient} on a non-2xx response. Carries the HTTP `status` so callers can
 * branch (e.g. 403 → "not your thread", 429 → quota) instead of string-matching a generic Error.
 */
export class AgentHttpError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    statusText: string,
  ) {
    super(`Agent request failed: ${method} ${path} → ${status} ${statusText}`);
    this.name = 'AgentHttpError';
  }
}

export interface QuotaToday {
  usedTokens: number;
}

export interface CancelResult {
  aborted: boolean;
}

export interface AgentClientOptions {
  /** Origin + base path, e.g. `https://api.example.com`. Defaults to `''`. */
  baseUrl?: string;
  /** Static headers merged into every request. */
  headers?: Record<string, string>;
  /** Resolved per request — for short-lived bearer tokens. */
  getHeaders?: () => Record<string, string> | Promise<Record<string, string>>;
  /** Forwarded to fetch so cookie auth works. */
  credentials?: RequestCredentials;
  /** Injectable for tests / non-browser runtimes. */
  fetch?: typeof fetch;
}

/**
 * Framework-agnostic REST client for the nestjs-agent endpoints. Used by
 * `useAgentChat`, but standalone-usable (vanilla fetch, no React).
 */
export class AgentClient {
  constructor(private readonly options: AgentClientOptions = {}) {}

  listThreads(): Promise<ThreadSummary[]> {
    return this.request<ThreadSummary[]>('GET', '/agent/threads');
  }

  getThread(id: string): Promise<ThreadDetail> {
    return this.request<ThreadDetail>('GET', `/agent/threads/${encodeURIComponent(id)}`);
  }

  deleteThread(id: string): Promise<void> {
    return this.request<void>('DELETE', `/agent/threads/${encodeURIComponent(id)}`);
  }

  forkFromMessage(threadId: string, messageId: string): Promise<ThreadSummary> {
    return this.request<ThreadSummary>(
      'POST',
      `/agent/threads/${encodeURIComponent(threadId)}/fork-from/${encodeURIComponent(messageId)}`,
    );
  }

  getQuotaToday(): Promise<QuotaToday> {
    return this.request<QuotaToday>('GET', '/agent/quota/today');
  }

  cancelStream(runId: string): Promise<CancelResult> {
    return this.request<CancelResult>('POST', `/agent/chat/${encodeURIComponent(runId)}/cancel`);
  }

  approveToolCall(input: { toolCallId: string }): Promise<void> {
    return this.request<void>('POST', '/agent/tool-call/approve', input);
  }

  rejectToolCall(input: { toolCallId: string; reason?: string }): Promise<void> {
    return this.request<void>('POST', '/agent/tool-call/reject', input);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const fetchImpl = this.options.fetch ?? globalThis.fetch;
    const baseUrl = (this.options.baseUrl ?? '').replace(/\/$/, '');
    const dynamic = (await this.options.getHeaders?.()) ?? {};
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: {
        accept: 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...this.options.headers,
        ...dynamic,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(this.options.credentials !== undefined ? { credentials: this.options.credentials } : {}),
    });
    if (!response.ok) {
      throw new AgentHttpError(response.status, method, path, response.statusText);
    }
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }
}
