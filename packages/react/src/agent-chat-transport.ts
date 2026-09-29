import type { AgentStreamEvent } from '@dudousxd/nestjs-agent-core';
import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai';
import { reasoningDurationMetadata } from './reasoning/timing.js';

/** JSON-safe metadata, as the SDK's `toolMetadata` requires (its `JSONObject` is not exported). */
type ToolMetadata = { [key: string]: string };

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
  /**
   * Fires synchronously at the very start of `sendMessages`/`reconnectToStream`, before any network
   * call — i.e. strictly before that attempt's own `onMeta` (if any) can fire. Lets a caller reset
   * "which run is THIS attempt settling" state without racing React's render/effect timing: a
   * consumer that also read `onMeta` to learn the current run id would otherwise risk misattributing
   * an early failure (no meta ever arrives) to a PRIOR attempt's id.
   */
  onAttemptStart?: () => void;
  /** Injectable for tests / non-browser runtimes. Defaults to global fetch. */
  fetch?: typeof fetch;
}

const HEADER_RUN_ID = 'x-agent-run-id';
const HEADER_THREAD_ID = 'x-agent-thread-id';

/**
 * The tool name BOTH elicitation surfaces persist their question set under (core's
 * `ASK_TOOL_NAME`), so a synthesized part and a replayed `tool-ask` row are the same part type.
 * Spelled out rather than imported: every other core import in this package is type-only, and a
 * value import would pull the agent loop into a browser bundle for a three-letter string.
 */
const ASK_TOOL_NAME = 'ask';

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
 *
 * Frames beyond text/reasoning/tools become AI SDK data parts (seen by `useChat`'s `onData`):
 *  - `ui`                 → `data-ui` part, `id` = the component id (a repeat id updates it in place)
 *  - `approval-requested` → `data-approval-requested` part keyed by the call id, plus the SDK's
 *                           native `tool-approval-request` (the part moves to `approval-requested`)
 *  - `title`, `cancelled` → transient `data-title` / `data-cancelled` (never stored on the message)
 *  - any other kind       → `data-<kind>` part carrying the frame minus `kind`, keyed by its `id`
 *                           when it has one — forwarded, never dropped
 * `parentId` on a tool frame rides the part's `toolMetadata` next to `toolKind`.
 */
export class AgentChatTransport implements ChatTransport<UIMessage> {
  private currentRunId: string | undefined;
  private currentThreadId: string | undefined;

  /**
   * One attempt at a time. The AI SDK keeps a single in-flight response per chat and decides
   * whether its streamed message REPLACES the list's last entry or is appended by comparing that
   * response's message id against the last entry alone. Two attempts writing into one chat
   * therefore append alternating copies of each other's message, and the list ends up holding
   * several entries under each id — which React renders as duplicate keys.
   */
  private attemptLive = false;

  constructor(private readonly options: AgentChatTransportOptions = {}) {}

  /** Run id of the most recent stream — HITL approve/reject target this. */
  get runId(): string | undefined {
    return this.currentRunId;
  }

  /** Thread id of the most recent stream. */
  get threadId(): string | undefined {
    return this.currentThreadId;
  }

  /**
   * True from the moment a send or resume attempt starts until its chunk stream terminates. A
   * caller that can refuse a turn BEFORE the SDK commits to one — `useAgentChat` wrapping
   * `sendMessage` — reads this; the transport itself can only refuse a resume, which is the one
   * attempt the SDK lets a transport decline.
   */
  get isAttemptLive(): boolean {
    return this.attemptLive;
  }

  async sendMessages(
    options: Parameters<ChatTransport<UIMessage>['sendMessages']>[0],
  ): Promise<ReadableStream<UIMessageChunk>> {
    this.options.onAttemptStart?.();
    this.attemptLive = true;
    try {
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
        ...(this.options.credentials !== undefined
          ? { credentials: this.options.credentials }
          : {}),
        ...(options.abortSignal ? { signal: options.abortSignal } : {}),
      });
      if (!response.ok || !response.body) {
        throw new Error(`Agent chat request failed: ${response.status} ${response.statusText}`);
      }
      this.captureHeaderMeta(response.headers);
      return this.toChunkStream(response.body);
    } catch (error) {
      this.attemptLive = false;
      throw error;
    }
  }

  async reconnectToStream(
    options: Parameters<ChatTransport<UIMessage>['reconnectToStream']>[0],
  ): Promise<ReadableStream<UIMessageChunk> | null> {
    // Already attached: a second reconnect replays the SAME buffered frames into the SAME chat, so
    // it adds a duplicate of the message the first attempt is writing rather than a second turn.
    // React StrictMode runs the SDK's resume effect twice on mount, which makes this the ordinary
    // case and not an edge one. `null` is the SDK's own "nothing to resume" answer and, unlike a
    // throw, leaves it holding no state for an attempt that never happened.
    if (this.attemptLive) return null;
    this.options.onAttemptStart?.();
    const runId = this.options.getResumeRunId?.();
    // No buffered run → resolve null without a network round-trip so we
    // never surface a 404 from a doomed resume GET.
    if (runId === undefined) return null;
    this.attemptLive = true;
    try {
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
      if (response.status === 404) {
        this.attemptLive = false;
        return null;
      }
      if (!response.ok || !response.body) {
        throw new Error(`Agent stream reconnect failed: ${response.status} ${response.statusText}`);
      }
      this.captureHeaderMeta(response.headers);
      return this.toChunkStream(response.body);
    } catch (error) {
      this.attemptLive = false;
      throw error;
    }
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
   *  - `data: <AgentStreamEvent JSON>`                → mapped to UI chunks (text / reasoning / tool /
   *                                                     `data-*`; see {@link AgentChatTransport} docs)
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
    // When the open reasoning run started, for the duration stamped on its end when the backend
    // does not report one (see `closeRuns`).
    let reasoningStartedAt = 0;
    // Text/reasoning runs opened within the current step. A pushed UI component closes the open run
    // so prose after it lands AFTER it; the next run then needs an id of its own.
    let textSeq = 0;
    let reasoningSeq = 0;
    // Tool calls this STREAM has already announced. The AI SDK settles a tool part by looking it
    // up by call id and throws — dropping the whole message — when there is none, so an outcome
    // must never be the first a client hears of a call. Per stream, not per transport: a resumed
    // run replays its buffered frames from the beginning.
    const announced = new Set<string>();
    // What each call's tool part carries as `toolMetadata`. The SDK REPLACES a part's metadata with
    // whatever the latest chunk carries, so a `parentId` learnt from `tool-input-start` would be
    // wiped by the `tool-input-available` that follows unless every chunk restates the merge.
    const toolMetadata = new Map<string, ToolMetadata>();
    const record = (meta: AgentStreamMeta) => this.recordMeta(meta);
    // Every way out of the read loop below passes through here: the attempt is over the moment its
    // chunk stream terminates, and a latch left set would refuse every later turn.
    const endAttempt = () => {
      this.attemptLive = false;
    };

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
          textSeq = 0;
          reasoningSeq = 0;
          controller.enqueue({ type: 'start-step' });
        }
        function ensureStep() {
          if (!stepOpen) openStep();
        }
        /**
         * `reasoningMs` is the backend's own measurement (`step-finish.reasoningMs`) — the number the
         * store persists, so a reloaded thread reads the same duration. Without one, the time this
         * client watched the run stream, which is what the reader saw but reads ~0 on a replay.
         */
        function closeRuns(reasoningMs?: number) {
          if (textId !== null) {
            controller.enqueue({ type: 'text-end', id: textId });
            textId = null;
          }
          if (reasoningId !== null) {
            controller.enqueue({
              type: 'reasoning-end',
              id: reasoningId,
              providerMetadata: reasoningDurationMetadata(
                reasoningMs ?? Math.max(0, Date.now() - reasoningStartedAt),
              ),
            });
            reasoningId = null;
          }
        }
        function closeStep(reasoningMs?: number) {
          if (!stepOpen) return;
          closeRuns(reasoningMs);
          controller.enqueue({ type: 'finish-step' });
          stepOpen = false;
        }
        /** Merge what this frame says about a call into what earlier frames said, and return it. */
        function metadataFor(
          id: string,
          toolKind: string | undefined,
          parentId: string | undefined,
        ): ToolMetadata | undefined {
          const merged: ToolMetadata = { ...toolMetadata.get(id) };
          if (toolKind !== undefined) merged.toolKind = toolKind;
          // A call's parent is fixed by the first frame that names one.
          if (parentId !== undefined && merged.parentId === undefined) merged.parentId = parentId;
          if (Object.keys(merged).length === 0) return undefined;
          toolMetadata.set(id, merged);
          return merged;
        }
        /** Forward a frame this transport has no dedicated mapping for as an AI SDK data part. */
        function forwardAsData(event: { kind: string }, transient: boolean) {
          ensureStarted();
          const { kind, ...data } = event as { kind: string } & Record<string, unknown>;
          controller.enqueue({
            type: `data-${kind}`,
            ...(typeof data.id === 'string' ? { id: data.id } : {}),
            data,
            ...(transient ? { transient: true } : {}),
          });
        }
        function emit(event: AgentStreamEvent) {
          switch (event.kind) {
            case 'step-start':
              openStep();
              break;
            case 'step-finish':
              closeStep(event.reasoningMs);
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
                textId = textSeq === 0 ? `txt-${stepIndex}` : `txt-${stepIndex}.${textSeq}`;
                textSeq += 1;
                controller.enqueue({ type: 'text-start', id: textId });
              }
              controller.enqueue({ type: 'text-delta', id: textId, delta: event.text });
              break;
            case 'reasoning':
              ensureStep();
              if (reasoningId === null) {
                reasoningId =
                  reasoningSeq === 0 ? `rsn-${stepIndex}` : `rsn-${stepIndex}.${reasoningSeq}`;
                reasoningSeq += 1;
                reasoningStartedAt = Date.now();
                controller.enqueue({ type: 'reasoning-start', id: reasoningId });
              }
              controller.enqueue({ type: 'reasoning-delta', id: reasoningId, delta: event.text });
              break;
            case 'tool-input-start': {
              ensureStep();
              announced.add(event.id);
              // `toolKind` is absent on older backends — omitted (not `undefined`-valued) so
              // `toolMetadata` itself is only present when there's something to say, letting a
              // UI gate approval affordances on `kind === 'action'` without hardcoding tool names.
              // `parentId` nests the call under another one (see `TranscriptToolCall.children`).
              const metadata = metadataFor(event.id, event.toolKind, event.parentId);
              controller.enqueue({
                type: 'tool-input-start',
                toolCallId: event.id,
                toolName: event.name,
                ...(metadata !== undefined ? { toolMetadata: metadata } : {}),
              });
              break;
            }
            case 'tool-input-delta':
              ensureStep();
              controller.enqueue({
                type: 'tool-input-delta',
                toolCallId: event.id,
                inputTextDelta: event.delta,
              });
              break;
            case 'tool-input-available': {
              ensureStep();
              announced.add(event.id);
              const metadata = metadataFor(event.id, event.toolKind, event.parentId);
              controller.enqueue({
                type: 'tool-input-available',
                toolCallId: event.id,
                toolName: event.name,
                input: event.input,
                ...(metadata !== undefined ? { toolMetadata: metadata } : {}),
              });
              break;
            }
            case 'elicitation':
              ensureStep();
              // An authored intake asks before the turn's first model call, so nothing announced
              // the call this question set is parked under — open it here, carrying the request as
              // the part's input, which is exactly what the store persists as the call's input and
              // therefore what a reloaded thread replays. The model's own `ask` announced its call
              // itself, and re-stating it would fire a consumer's `onToolCall` twice.
              if (!announced.has(event.id)) {
                announced.add(event.id);
                controller.enqueue({
                  type: 'tool-input-available',
                  toolCallId: event.id,
                  toolName: ASK_TOOL_NAME,
                  input: {
                    ...(event.request.preamble !== undefined
                      ? { preamble: event.request.preamble }
                      : {}),
                    questions: event.request.questions,
                  },
                });
              }
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
            case 'tool-output-denied':
              ensureStep();
              // The SDK's own state for "a person said no": it keeps the part's input and metadata
              // and only moves its state, so a card can say the decision was carried out instead of
              // drawing the red treatment an error gets. The reason (when one was given) rides the
              // persisted call, not this chunk — the SDK's shape carries no room for it.
              controller.enqueue({ type: 'tool-output-denied', toolCallId: event.id });
              break;
            case 'approval-requested':
              ensureStep();
              // Who decides and until when rides a `data-approval-requested` part keyed by the call
              // id — the SDK's approval chunk has no room for it, and restating the call's input
              // chunk to widen its metadata would fire a consumer's `onToolCall` a second time.
              forwardAsData(event, false);
              // The SDK settles an approval against a part it already holds and throws — dropping
              // the whole message — when there is none, so only a call this stream announced moves
              // into the native state. The approval id IS the call id: the lib settles approvals
              // by tool-call id, so a second identifier would only have to be mapped back.
              if (announced.has(event.id)) {
                controller.enqueue({
                  type: 'tool-approval-request',
                  approvalId: event.id,
                  toolCallId: event.id,
                });
              }
              break;
            case 'ui':
              ensureStep();
              // Positioned content: close the open prose so text written after the component
              // renders after it instead of growing the paragraph above it.
              closeRuns();
              controller.enqueue({
                type: 'data-ui',
                id: event.id,
                data: {
                  id: event.id,
                  component: event.component,
                  props: event.props,
                  ...(event.version !== undefined ? { version: event.version } : {}),
                },
              });
              break;
            case 'title':
            case 'cancelled':
              // Thread- and run-level facts, not message content: seen by `onData`, never stored
              // as a part of the message.
              forwardAsData(event, true);
              break;
            default:
              // A kind this version does not know (a newer server, a runner that is not this
              // library's loop). Forwarded rather than dropped, so a host can render it from
              // `message.parts` / `onData` without waiting for a release that maps it.
              forwardAsData(event as { kind: string }, false);
              break;
          }
        }
        function finish() {
          ensureStarted();
          closeStep();
          controller.enqueue({ type: 'finish' });
          controller.close();
          endAttempt();
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
                endAttempt();
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
          endAttempt();
        }
      },
      cancel() {
        void reader.cancel();
        endAttempt();
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
