import type { AgentStreamEvent } from '@dudousxd/nestjs-agent-core';
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
   * Extra body fields evaluated per send — the hook injects `threadId`
   * and `pageContext` through this. Returned object is spread into the
   * request body after the SDK's own `body`.
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
 * AI SDK v7 `ChatTransport` for the nestjs-agent backend. POSTs
 * `/agent/chat`, parses the backend's `meta` + `{delta}` + `done` SSE
 * frames, and re-emits them as the v7 UI-message chunk stream
 * (`start` → `text-start` → `text-delta`* → `text-end` → `finish`).
 *
 * The backend hydrates prior history from its store, so only the latest
 * user message text is sent each turn — keeping payloads tiny and
 * preventing the client from corrupting replayed history.
 *
 * Attachments (image/PDF for a vision-capable model) ride the per-send body:
 * `sendMessage({ text }, { body: { attachments: MessageAttachment[] } })`. They
 * flow to the backend as the turn's `attachments`, get persisted on the user
 * message, and are rendered as native model content parts. Optimistic display of
 * the user's own attachment thumbnails is the consumer's concern (it stages the
 * upload), the same way history rendering reads `StoredMessage.attachments`.
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
   * Parse the backend's SSE byte stream and re-emit it as a valid v7 UI-message chunk stream.
   * Recognized frames:
   *  - `event: meta`  `data: {"runId","threadId"}`   → records identity
   *  - `data: <AgentStreamEvent JSON>`                → mapped to UI chunks (text / reasoning / tool)
   *  - `event: done`  `data: {}`                      → terminates
   *  - `event: error` `data: {code,message}`          → error chunk
   *
   * A run is ONE UI message with N steps. Each `step-start`/`step-finish` pair brackets a model
   * call plus its tool execution; text and reasoning open lazily and close at the step boundary, so
   * tool-call cards (input streaming → output) render live between the prose.
   */
  private toChunkStream(source: ReadableStream<Uint8Array>): ReadableStream<UIMessageChunk> {
    const reader = source.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let started = false;
    let stepOpen = false;
    let stepIndex = 0;
    let textId: string | null = null;
    let reasoningId: string | null = null;
    const record = (meta: AgentStreamMeta) => this.recordMeta(meta);

    return new ReadableStream<UIMessageChunk>({
      async pull(controller) {
        function ensureStarted() {
          if (started) return;
          started = true;
          controller.enqueue({ type: 'start' });
        }
        function openStep() {
          ensureStarted();
          if (stepOpen) closeStep();
          stepOpen = true;
          stepIndex += 1;
          textId = null;
          reasoningId = null;
          controller.enqueue({ type: 'start-step' });
        }
        function ensureStep() {
          if (!stepOpen) openStep();
        }
        function closeStep() {
          if (!stepOpen) return;
          if (textId !== null) {
            controller.enqueue({ type: 'text-end', id: textId });
            textId = null;
          }
          if (reasoningId !== null) {
            controller.enqueue({ type: 'reasoning-end', id: reasoningId });
            reasoningId = null;
          }
          controller.enqueue({ type: 'finish-step' });
          stepOpen = false;
        }
        function emit(event: AgentStreamEvent) {
          switch (event.kind) {
            case 'step-start':
              openStep();
              break;
            case 'step-finish':
              closeStep();
              // `costUsd` rides the step boundary once the backend reports it (older backends omit
              // it entirely — `undefined`, never a crash). `null` means "priced provider/estimate
              // unavailable", distinct from a real $0 turn — surfaced verbatim as message metadata
              // (merged onto `message.metadata` by the AI SDK) so a UI can render running cost
              // without polling `GET /quota/today`.
              if (event.costUsd !== undefined) {
                controller.enqueue({
                  type: 'message-metadata',
                  messageMetadata: { costUsd: event.costUsd },
                });
              }
              break;
            case 'text':
              ensureStep();
              if (textId === null) {
                textId = `txt-${stepIndex}`;
                controller.enqueue({ type: 'text-start', id: textId });
              }
              controller.enqueue({ type: 'text-delta', id: textId, delta: event.text });
              break;
            case 'reasoning':
              ensureStep();
              if (reasoningId === null) {
                reasoningId = `rsn-${stepIndex}`;
                controller.enqueue({ type: 'reasoning-start', id: reasoningId });
              }
              controller.enqueue({ type: 'reasoning-delta', id: reasoningId, delta: event.text });
              break;
            case 'tool-input-start':
              ensureStep();
              controller.enqueue({
                type: 'tool-input-start',
                toolCallId: event.id,
                toolName: event.name,
                // `toolKind` is absent on older backends — omitted (not `undefined`-valued) so
                // `toolMetadata` itself is only present when there's something to say, letting a
                // UI gate approval affordances on `kind === 'action'` without hardcoding tool names.
                ...(event.toolKind !== undefined
                  ? { toolMetadata: { toolKind: event.toolKind } }
                  : {}),
              });
              break;
            case 'tool-input-delta':
              ensureStep();
              controller.enqueue({
                type: 'tool-input-delta',
                toolCallId: event.id,
                inputTextDelta: event.delta,
              });
              break;
            case 'tool-input-available':
              ensureStep();
              controller.enqueue({
                type: 'tool-input-available',
                toolCallId: event.id,
                toolName: event.name,
                input: event.input,
                ...(event.toolKind !== undefined
                  ? { toolMetadata: { toolKind: event.toolKind } }
                  : {}),
              });
              break;
            case 'tool-output':
              ensureStep();
              controller.enqueue({
                type: 'tool-output-available',
                toolCallId: event.id,
                output: event.output,
              });
              break;
            case 'tool-output-error':
              ensureStep();
              controller.enqueue({
                type: 'tool-output-error',
                toolCallId: event.id,
                errorText: event.error,
              });
              break;
            default:
              break;
          }
        }
        function finish() {
          ensureStarted();
          closeStep();
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
              if (frame.event === 'error') {
                ensureStarted();
                controller.enqueue({ type: 'error', errorText: parseErrorText(frame.data) });
                controller.close();
                return;
              }
              if (frame.event === 'meta') {
                const meta = parseMeta(frame.data);
                if (meta) record(meta);
              } else if (frame.data) {
                const event = parseEvent(frame.data);
                if (event) emit(event);
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

/** Pull a human-facing message out of the backend's `event: error` frame (`{code,message}`). */
function parseErrorText(data: string | undefined): string {
  if (!data) return 'Agent run failed';
  try {
    const parsed: unknown = JSON.parse(data);
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'message' in parsed &&
      typeof parsed.message === 'string'
    ) {
      return parsed.message;
    }
  } catch {
    /* malformed error frame — fall through to the default */
  }
  return 'Agent run failed';
}

/** Parse a `data:` frame as an `AgentStreamEvent`. Returns null for anything without a `kind`. */
function parseEvent(data: string): AgentStreamEvent | null {
  try {
    const parsed: unknown = JSON.parse(data);
    if (parsed !== null && typeof parsed === 'object' && 'kind' in parsed) {
      return parsed as AgentStreamEvent;
    }
  } catch {
    /* not an event frame — ignore */
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
