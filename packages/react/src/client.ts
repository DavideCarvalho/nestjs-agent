import type { Persona, ThreadDetail, ThreadSummary } from '@dudousxd/nestjs-agent-core';

/** The trimmed persona shape returned by `/agent/threads/personas/catalog`. */
export type PersonaCatalogEntry = Pick<Persona, 'id' | 'label'>;

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

  getPersonaCatalog(): Promise<PersonaCatalogEntry[]> {
    return this.request<PersonaCatalogEntry[]>('GET', '/agent/threads/personas/catalog');
  }

  getQuotaToday(): Promise<QuotaToday> {
    return this.request<QuotaToday>('GET', '/agent/quota/today');
  }

  cancelStream(runId: string): Promise<CancelResult> {
    return this.request<CancelResult>('POST', `/agent/chat/${encodeURIComponent(runId)}/cancel`);
  }

  approveToolCall(input: {
    runId: string;
    toolCallId: string;
  }): Promise<void> {
    return this.request<void>('POST', '/agent/tool-call/approve', input);
  }

  rejectToolCall(input: {
    runId: string;
    toolCallId: string;
    reason?: string;
  }): Promise<void> {
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
      throw new Error(
        `Agent request failed: ${method} ${path} → ${response.status} ${response.statusText}`,
      );
    }
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }
}
