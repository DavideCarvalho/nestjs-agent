import type {
  MessageAttachment,
  QuotaView,
  SkillCatalogEntry,
  ThreadDetail,
  ThreadSummary,
} from '@dudousxd/nestjs-agent-core';

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

/** The quota-today read-model: usage, the configured limit (null → unlimited), and USD spend. */
export type QuotaToday = QuotaView;

export interface CancelResult {
  aborted: boolean;
}

export interface OkResult {
  ok: boolean;
}

/**
 * Partial update accepted by `PATCH /agent/threads/:threadId`. `defaultAgent: null` clears a
 * previously-set default back to the module's own default; omitting it leaves the thread's
 * current default untouched.
 */
export interface ThreadPatch {
  title?: string;
  defaultAgent?: string | null;
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

  /**
   * The skills this caller can invoke right now, scope-resolved — the same list, built by the same
   * call, that the model is offered, so what a user can type after a `/` and what the agent can
   * reach cannot drift apart. `threadId` reaches the host's own resolver, which may scope a skill to
   * one conversation; omitted, the server reads it as a brand-new thread.
   */
  listSkills(threadId?: string): Promise<SkillCatalogEntry[]> {
    const query = threadId === undefined ? '' : `?threadId=${encodeURIComponent(threadId)}`;
    return this.request<SkillCatalogEntry[]>('GET', `/agent/skills${query}`);
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

  renameThread(id: string, title: string): Promise<OkResult> {
    return this.updateThread(id, { title });
  }

  /** General `PATCH /agent/threads/:threadId` — title and/or the thread's pinned default agent. */
  updateThread(id: string, patch: ThreadPatch): Promise<OkResult> {
    return this.request<OkResult>('PATCH', `/agent/threads/${encodeURIComponent(id)}`, patch);
  }

  /**
   * Uploads a file (image/PDF) for a vision-capable model turn. Multipart, field name `file` —
   * mirrors the backend's `POST /agent/attachments`. The returned {@link MessageAttachment} is
   * what a caller then rides on `sendMessage({ text }, { body: { attachments: [...] } })`.
   */
  async uploadAttachment(file: File): Promise<MessageAttachment> {
    const fetchImpl = this.options.fetch ?? globalThis.fetch;
    const baseUrl = (this.options.baseUrl ?? '').replace(/\/$/, '');
    const dynamic = (await this.options.getHeaders?.()) ?? {};
    const formData = new FormData();
    formData.append('file', file);
    const response = await fetchImpl(`${baseUrl}/agent/attachments`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        ...this.options.headers,
        ...dynamic,
      },
      body: formData,
      ...(this.options.credentials !== undefined ? { credentials: this.options.credentials } : {}),
    });
    return this.handleResponse<MessageAttachment>(response, 'POST', '/agent/attachments');
  }

  promoteThread(id: string): Promise<OkResult> {
    return this.request<OkResult>('POST', `/agent/threads/${encodeURIComponent(id)}/promote`);
  }

  truncateFromMessage(threadId: string, messageId: string): Promise<OkResult> {
    return this.request<OkResult>(
      'DELETE',
      `/agent/threads/${encodeURIComponent(threadId)}/from/${encodeURIComponent(messageId)}`,
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

  /**
   * Settle a parked question set. `answers` is questionId → chosen option values; a question left
   * out takes the pre-picked default the request carried, resolved server-side against the request
   * the run already holds. Omit the whole object and the user has confirmed every pre-picked
   * answer — which is the point of the surface, so it is a valid submission rather than a blank.
   */
  answerToolCall(input: {
    toolCallId: string;
    answers?: Record<string, string[]>;
  }): Promise<void> {
    return this.request<void>('POST', '/agent/tool-call/answer', input);
  }

  /**
   * Decline to answer and let the agent proceed on its own pre-picked values. Lands on the same
   * values a confirmation would, and persists differently on purpose — only one of them is
   * evidence the user chose them.
   */
  skipToolCall(input: { toolCallId: string }): Promise<void> {
    return this.request<void>('POST', '/agent/tool-call/skip', input);
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
    return this.handleResponse<T>(response, method, path);
  }

  private async handleResponse<T>(response: Response, method: string, path: string): Promise<T> {
    if (!response.ok) {
      throw new AgentHttpError(response.status, method, path, response.statusText);
    }
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }
}
