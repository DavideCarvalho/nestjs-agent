import type {
  AgentCatalogEntry,
  MessageAttachment,
  MessageFeedback,
  ModelCatalogView,
  QuotaView,
  SkillCatalogEntry,
  ThreadDetail,
  ThreadSummary,
  ToolCatalogEntry,
} from '@dudousxd/nestjs-agent-core';
import type {
  AgentBackend,
  ChatStreamRequest,
  ChatStreamResponse,
  MessageFeedbackInput,
  ResumeStreamRequest,
  ThreadPatch,
  UploadAttachmentOptions,
} from './backend.js';

export type { ThreadPatch } from './backend.js';

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

export interface AgentClientOptions {
  /** Origin + base path, e.g. `https://api.example.com`. Defaults to `''`. */
  baseUrl?: string;
  /** Static headers merged into every request. */
  headers?: Record<string, string>;
  /**
   * Resolved per request — for short-lived bearer tokens, or a CSRF header read from a cookie
   * (`{ 'X-XSRF-TOKEN': readCookie('XSRF-TOKEN') }`), which has to be read at request time because
   * the server may rotate it.
   */
  getHeaders?: () => Record<string, string> | Promise<Record<string, string>>;
  /**
   * Forwarded to fetch so cookie auth works. Same-origin requests send cookies by default; set
   * `'include'` when the API lives on another origin (and have it answer with credentialed CORS).
   */
  credentials?: RequestCredentials;
  /** Injectable for tests / non-browser runtimes. */
  fetch?: typeof fetch;
}

const HEADER_RUN_ID = 'x-agent-run-id';
const HEADER_THREAD_ID = 'x-agent-thread-id';

/**
 * Framework-agnostic REST client for the nestjs-agent endpoints — the default {@link AgentBackend}.
 * Used by `useAgentChat`, but standalone-usable (vanilla fetch, no React).
 */
export class AgentClient implements AgentBackend {
  constructor(private readonly options: AgentClientOptions = {}) {}

  /** `POST /agent/chat` → the turn's SSE stream. Throws {@link AgentHttpError} on a non-2xx. */
  async openChatStream(request: ChatStreamRequest): Promise<ChatStreamResponse> {
    const response = await this.fetchImpl()(`${this.baseUrl()}/agent/chat`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        ...(await this.resolveHeaders()),
        ...request.headers,
      },
      body: JSON.stringify(request.body),
      ...this.credentials(),
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
    });
    if (!response.ok || !response.body) {
      throw new AgentHttpError(response.status, 'POST', '/agent/chat', response.statusText);
    }
    return streamResponse(response);
  }

  /**
   * `GET /agent/chat/:runId/stream[?after=<seq>]` → the run's SSE stream, or `null` when nothing is
   * streaming under that id (404).
   */
  async resumeChatStream(request: ResumeStreamRequest): Promise<ChatStreamResponse | null> {
    const path = `/agent/chat/${encodeURIComponent(request.runId)}/stream`;
    const query = request.after !== undefined && request.after > 0 ? `?after=${request.after}` : '';
    const response = await this.fetchImpl()(`${this.baseUrl()}${path}${query}`, {
      method: 'GET',
      headers: {
        accept: 'text/event-stream',
        ...(await this.resolveHeaders()),
        ...request.headers,
      },
      ...this.credentials(),
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
    });
    if (response.status === 404) {
      return null;
    }
    if (!response.ok || !response.body) {
      throw new AgentHttpError(response.status, 'GET', path, response.statusText);
    }
    return streamResponse(response);
  }

  /**
   * Rate a message (`'up'`/`'down'`, optional comment) or clear its rating (`value: null`). Answers
   * the stored rating.
   */
  setMessageFeedback(
    messageId: string,
    input: MessageFeedbackInput,
  ): Promise<{ feedback: MessageFeedback | null }> {
    return this.request<{ feedback: MessageFeedback | null }>(
      'POST',
      `/agent/messages/${encodeURIComponent(messageId)}/feedback`,
      input,
    );
  }

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

  /**
   * The tools this caller can reach through `agent` (the default agent when omitted), each with the
   * server-declared `presentation` a chat narrates it by — the same list the model is offered.
   * Prefer {@link useToolCatalog}, which fetches it once and shares it.
   */
  listTools(agent?: string): Promise<ToolCatalogEntry[]> {
    const query = agent === undefined ? '' : `?agent=${encodeURIComponent(agent)}`;
    return this.request<ToolCatalogEntry[]>('GET', `/agent/tools${query}`);
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
  async uploadAttachment(
    file: File,
    options: UploadAttachmentOptions = {},
  ): Promise<MessageAttachment> {
    const formData = new FormData();
    formData.append('file', file);
    const response = await this.fetchImpl()(`${this.baseUrl()}/agent/attachments`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        ...(await this.resolveHeaders()),
      },
      body: formData,
      ...this.credentials(),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
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

  /** `GET /agent/models?agent=` — the models this caller may pick, grouped by provider. */
  listModels(agent?: string): Promise<ModelCatalogView> {
    const query = agent === undefined ? '' : `?agent=${encodeURIComponent(agent)}`;
    return this.request<ModelCatalogView>('GET', `/agent/models${query}`);
  }

  /** `GET /agent/agents` — the registered agents, the default one flagged. */
  listAgents(): Promise<AgentCatalogEntry[]> {
    return this.request<AgentCatalogEntry[]>('GET', '/agent/agents');
  }

  getQuotaToday(): Promise<QuotaToday> {
    return this.request<QuotaToday>('GET', '/agent/quota/today');
  }

  cancelStream(runId: string): Promise<CancelResult> {
    return this.request<CancelResult>('POST', `/agent/chat/${encodeURIComponent(runId)}/cancel`);
  }

  /**
   * `remember` approves later calls of the same tool in the same thread; `via` names the surface
   * the decision came through (the server records `'web'` when omitted).
   */
  approveToolCall(input: { toolCallId: string; remember?: boolean; via?: string }): Promise<void> {
    return this.request<void>('POST', '/agent/tool-call/approve', input);
  }

  rejectToolCall(input: { toolCallId: string; reason?: string; via?: string }): Promise<void> {
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

  private fetchImpl(): typeof fetch {
    return this.options.fetch ?? globalThis.fetch;
  }

  private baseUrl(): string {
    return (this.options.baseUrl ?? '').replace(/\/$/, '');
  }

  private async resolveHeaders(): Promise<Record<string, string>> {
    const dynamic = (await this.options.getHeaders?.()) ?? {};
    return { ...this.options.headers, ...dynamic };
  }

  private credentials(): { credentials?: RequestCredentials } {
    return this.options.credentials !== undefined ? { credentials: this.options.credentials } : {};
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.fetchImpl()(`${this.baseUrl()}${path}`, {
      method,
      headers: {
        accept: 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(await this.resolveHeaders()),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...this.credentials(),
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

function streamResponse(response: Response): ChatStreamResponse {
  const body = response.body as ReadableStream<Uint8Array>;
  const runId = response.headers?.get(HEADER_RUN_ID) ?? undefined;
  const threadId = response.headers?.get(HEADER_THREAD_ID) ?? undefined;
  return {
    body,
    ...(runId ? { runId } : {}),
    ...(threadId ? { threadId } : {}),
  };
}
