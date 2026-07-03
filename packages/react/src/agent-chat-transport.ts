import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai';

/** Identity surfaced by the backend's `meta` SSE frame / response headers. */
export interface AgentStreamMeta {
  runId: string;
  threadId: string;
}

export interface AgentChatTransportOptions {
  /**
   * Origin + base path the agent endpoints hang off, e.g.
   * `https://api.example.com`. Endpoints are appended as
   * `${baseUrl}/agent/chat` etc. Defaults to `''` (same origin).
   */
  baseUrl?: string;
  /** Static headers merged into every request (e.g. a tenant ref). */
  headers?: Record<string, string>;
  /**
   * Resolved at request time — use for short-lived bearer tokens that
   * must not be captured once at construction. Merged over `headers`.
   */
  getHeaders?: () => Record<string, string> | Promise<Record<string, string>>;
  /** Forwarded to `fetch` so cookie-based auth/impersonation works. */
  credentials?: RequestCredentials;
  /** Named agent to run the turn (backend `agent` field). */
  agent?: string;
  /**
   * Extra body fields evaluated per send — the hook injects `threadId`,
   * `persona`, and `pageContext` through this. Returned object is spread
   * into the request body after the SDK's own `body`.
   */
  getBody?: () => Record<string, unknown>;
  /**
   * The run id to resume on mount, if any. Returning `undefined` makes
   * `reconnectToStream` resolve to `null` WITHOUT hitting the network —
   * this is the generalized fix for "useChat fires a doomed GET on mount
   * and surfaces its 404". Wire this to the thread's `activeStreamId`.
   */
  getResumeRunId?: () => string | undefined;
  /** Fires whenever a stream emits its `meta` frame. */
  onMeta?: (meta: AgentStreamMeta) => void;
  /** Injectable for tests / non-browser runtimes. Defaults to global fetch. */
  fetch?: typeof fetch;
}

const HEADER_RUN_ID = 'x-agent-run-id';
const HEADER_THREAD_ID = 'x-agent-thread-id';

/**
 * AI SDK v6 `ChatTransport` for the nestjs-agent backend. POSTs
 * `/agent/chat`, parses the backend's `meta` + `{delta}` + `done` SSE
 * frames, and re-emits them as the v6 UI-message chunk stream
 * (`start` → `text-start` → `text-delta`* → `text-end` → `finish`).
 *
 * The backend hydrates prior history from its store, so only the latest
 * user message text is sent each turn — keeping payloads tiny and
 * preventing the client from corrupting replayed history.
 */
export class AgentChatTransport implements ChatTransport<UIMessage> {
  private currentRunId: string | undefined;
  private currentThreadId: string | undefined;

  constructor(private readonly options: AgentChatTransportOptions = {}) {}

  /** Run id of the most recent stream — HITL approve/reject target this. */
  get runId(): string | undefined {
    return this.currentRunId;
  }

  /** Thread id of the most recent stream. */
  get threadId(): string | undefined {
    return this.currentThreadId;
  }

  async sendMessages(
    options: Parameters<ChatTransport<UIMessage>['sendMessages']>[0],
  ): Promise<ReadableStream<UIMessageChunk>> {
    const lastMessage = options.messages.at(-1);
    const message = lastMessage ? extractText(lastMessage) : '';
    const body: Record<string, unknown> = {
      ...(this.options.agent !== undefined ? { agent: this.options.agent } : {}),
      ...(this.options.getBody?.() ?? {}),
      ...((options.body as Record<string, unknown> | undefined) ?? {}),
      message,
    };
    const response = await this.fetchImpl()(`${this.baseUrl()}/agent/chat`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        ...(await this.resolveHeaders(options.headers)),
      },
      body: JSON.stringify(body),
      ...(this.options.credentials !== undefined ? { credentials: this.options.credentials } : {}),
      ...(options.abortSignal ? { signal: options.abortSignal } : {}),
    });
    if (!response.ok || !response.body) {
      throw new Error(`Agent chat request failed: ${response.status} ${response.statusText}`);
    }
    this.captureHeaderMeta(response.headers);
    return this.toChunkStream(response.body);
  }

  async reconnectToStream(
    options: Parameters<ChatTransport<UIMessage>['reconnectToStream']>[0],
  ): Promise<ReadableStream<UIMessageChunk> | null> {
    const runId = this.options.getResumeRunId?.();
    // No buffered run → resolve null without a network round-trip so we
    // never surface a 404 from a doomed resume GET.
    if (runId === undefined) return null;
    const response = await this.fetchImpl()(
      `${this.baseUrl()}/agent/chat/${encodeURIComponent(runId)}/stream`,
      {
        method: 'GET',
        headers: {
          accept: 'text/event-stream',
          ...(await this.resolveHeaders(options.headers)),
        },
        ...(this.options.credentials !== undefined
          ? { credentials: this.options.credentials }
          : {}),
      },
    );
    if (response.status === 404) return null;
    if (!response.ok || !response.body) {
      throw new Error(`Agent stream reconnect failed: ${response.status} ${response.statusText}`);
    }
    this.captureHeaderMeta(response.headers);
    return this.toChunkStream(response.body);
  }

  private fetchImpl(): typeof fetch {
    return this.options.fetch ?? globalThis.fetch;
  }

  private baseUrl(): string {
    return (this.options.baseUrl ?? '').replace(/\/$/, '');
  }

  private async resolveHeaders(
    perRequest: Record<string, string> | Headers | undefined,
  ): Promise<Record<string, string>> {
    const dynamic = (await this.options.getHeaders?.()) ?? {};
    const extra =
      perRequest instanceof Headers ? Object.fromEntries(perRequest.entries()) : (perRequest ?? {});
    return { ...this.options.headers, ...dynamic, ...extra };
  }

  private captureHeaderMeta(headers: Headers): void {
    const runId = headers.get(HEADER_RUN_ID);
    const threadId = headers.get(HEADER_THREAD_ID);
    if (runId) this.currentRunId = runId;
    if (threadId) this.currentThreadId = threadId;
  }

  private recordMeta(meta: AgentStreamMeta): void {
    this.currentRunId = meta.runId;
    this.currentThreadId = meta.threadId;
    this.options.onMeta?.(meta);
  }

  /**
   * Parse the backend's SSE byte stream and synthesize a valid v6
   * UI-message chunk stream. Recognized backend frames:
   *  - `event: meta`  `data: {"runId","threadId"}`  → records identity
   *  - `data: {"delta":"..."}`                       → `text-delta`
   *  - `event: done`  `data: {}`                     → terminates
   */
  private toChunkStream(source: ReadableStream<Uint8Array>): ReadableStream<UIMessageChunk> {
    const reader = source.getReader();
    const decoder = new TextDecoder();
    const textId = `txt-${Math.random().toString(36).slice(2)}`;
    let buffer = '';
    let started = false;
    const record = (meta: AgentStreamMeta) => this.recordMeta(meta);

    return new ReadableStream<UIMessageChunk>({
      async pull(controller) {
        function ensureStarted() {
          if (started) return;
          started = true;
          controller.enqueue({ type: 'start' });
          controller.enqueue({ type: 'start-step' });
          controller.enqueue({ type: 'text-start', id: textId });
        }
        function finish() {
          ensureStarted();
          controller.enqueue({ type: 'text-end', id: textId });
          controller.enqueue({ type: 'finish-step' });
          controller.enqueue({ type: 'finish' });
          controller.close();
        }
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              finish();
              return;
            }
            buffer += decoder.decode(value, { stream: true });
            let separator = buffer.indexOf('\n\n');
            while (separator !== -1) {
              const rawEvent = buffer.slice(0, separator);
              buffer = buffer.slice(separator + 2);
              const frame = parseSseFrame(rawEvent);
              if (frame.event === 'done') {
                finish();
                return;
              }
              if (frame.event === 'meta') {
                const meta = parseMeta(frame.data);
                if (meta) record(meta);
              } else if (frame.data) {
                const delta = parseDelta(frame.data);
                if (delta) {
                  ensureStarted();
                  controller.enqueue({
                    type: 'text-delta',
                    id: textId,
                    delta,
                  });
                }
              }
              separator = buffer.indexOf('\n\n');
            }
          }
        } catch (error) {
          controller.enqueue({
            type: 'error',
            errorText: error instanceof Error ? error.message : 'Agent stream error',
          });
          controller.close();
        }
      },
      cancel() {
        void reader.cancel();
      },
    });
  }
}

interface SseFrame {
  event: string | undefined;
  data: string | undefined;
}

/** Split one `event:`/`data:` SSE block into its fields. */
function parseSseFrame(raw: string): SseFrame {
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith('event:')) {
      event = line.slice('event:'.length).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trimStart());
    }
  }
  return {
    event,
    data: dataLines.length > 0 ? dataLines.join('\n') : undefined,
  };
}

function parseMeta(data: string | undefined): AgentStreamMeta | null {
  if (!data) return null;
  try {
    const parsed: unknown = JSON.parse(data);
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'runId' in parsed &&
      'threadId' in parsed &&
      typeof parsed.runId === 'string' &&
      typeof parsed.threadId === 'string'
    ) {
      return { runId: parsed.runId, threadId: parsed.threadId };
    }
  } catch {
    /* malformed meta frame — ignore */
  }
  return null;
}

function parseDelta(data: string): string | null {
  try {
    const parsed: unknown = JSON.parse(data);
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'delta' in parsed &&
      typeof parsed.delta === 'string'
    ) {
      return parsed.delta;
    }
  } catch {
    /* not a delta frame — ignore */
  }
  return null;
}

/** Collect all text parts of a UI message into a single string. */
function extractText(message: UIMessage): string {
  let text = '';
  for (const part of message.parts ?? []) {
    if (part.type === 'text') text += part.text;
  }
  return text;
}
