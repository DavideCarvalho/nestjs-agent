import type {
  MessageAttachment,
  MessageFeedback,
  MessageFeedbackValue,
  QuotaView,
  SkillCatalogEntry,
  ThreadDetail,
  ThreadSummary,
  ToolCatalogEntry,
} from '@dudousxd/nestjs-agent-core';

/**
 * Partial update accepted by `PATCH <base>/threads/:threadId`. `defaultAgent: null` clears a
 * previously-set default back to the module's own default; omitting it leaves the thread's
 * current default untouched.
 */
export interface ThreadPatch {
  title?: string;
  defaultAgent?: string | null;
}

/** Starting a turn: the body `POST <base>/chat` takes (see docs/stream-protocol.md). */
export interface ChatStreamRequest {
  /** `{ message, threadId?, agent?, attachments?, pageContext?, regenerate?, … }`. */
  body: Record<string, unknown>;
  /** Per-request headers the AI SDK was handed for this send. */
  headers?: Record<string, string>;
  /** Aborted when the user stops the turn. */
  signal?: AbortSignal;
}

/** Attaching to a run that is already streaming: `GET <base>/chat/:runId/stream?after=<seq>`. */
export interface ResumeStreamRequest {
  runId: string;
  /**
   * The sequence number (SSE `id:`) of the last frame the client already has. Omitted → replay
   * from the first frame. A backend that cannot skip may ignore it: the transport also drops frames
   * at or below it.
   */
  after?: number;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

/**
 * An open chat stream: the raw `text/event-stream` bytes in the stream-protocol framing, plus the
 * identity a backend may learn before the first frame (the `X-Agent-Run-Id` / `X-Agent-Thread-Id`
 * headers). The body's own `event: meta` frame supplies them otherwise.
 */
export interface ChatStreamResponse {
  body: ReadableStream<Uint8Array>;
  runId?: string;
  threadId?: string;
}

/** What `POST <base>/messages/:id/feedback` takes. `value: null` clears the rating. */
export interface MessageFeedbackInput {
  value: MessageFeedbackValue | null;
  comment?: string;
}

export interface UploadAttachmentOptions {
  signal?: AbortSignal;
  /** Called with 0..1 as the upload progresses, when the backend can observe it. */
  onProgress?: (fraction: number) => void;
}

/**
 * Everything the React layer asks of a server — the seam between `useAgentChat` (and the other
 * hooks) and whatever serves the agent. {@link AgentClient} is the default implementation, over the
 * library's own REST routes with `fetch`. An app with its own client — a generated one, a different
 * auth scheme (cookie session + CSRF header), a backend that is not this library at all but speaks
 * docs/stream-protocol.md — implements this instead and passes it as `useAgentChat({ backend })`.
 *
 * The streaming, thread and cancel members are required: without them there is no chat. The rest
 * are optional; a hook that needs one the backend does not have throws
 * {@link AgentBackendUnsupportedError} when it is called, so a backend only implements what its
 * server supports.
 */
export interface AgentBackend {
  /** Start a turn and return its SSE stream. Throw on a non-2xx answer. */
  openChatStream(request: ChatStreamRequest): Promise<ChatStreamResponse>;
  /** Attach to a streaming run. Resolve `null` when nothing is streaming under that id (HTTP 404). */
  resumeChatStream(request: ResumeStreamRequest): Promise<ChatStreamResponse | null>;
  /** Hard-stop a run server-side. */
  cancelStream(runId: string): Promise<unknown>;

  listThreads(): Promise<ThreadSummary[]>;
  getThread(id: string): Promise<ThreadDetail>;
  updateThread(id: string, patch: ThreadPatch): Promise<unknown>;
  deleteThread(id: string): Promise<unknown>;

  forkFromMessage?(threadId: string, messageId: string): Promise<ThreadSummary>;
  promoteThread?(id: string): Promise<unknown>;
  truncateFromMessage?(threadId: string, messageId: string): Promise<unknown>;

  approveToolCall?(input: {
    toolCallId: string;
    remember?: boolean;
    via?: string;
  }): Promise<unknown>;
  rejectToolCall?(input: { toolCallId: string; reason?: string; via?: string }): Promise<unknown>;
  answerToolCall?(input: {
    toolCallId: string;
    answers?: Record<string, string[]>;
  }): Promise<unknown>;
  skipToolCall?(input: { toolCallId: string }): Promise<unknown>;

  uploadAttachment?(file: File, options?: UploadAttachmentOptions): Promise<MessageAttachment>;
  listTools?(agent?: string): Promise<ToolCatalogEntry[]>;
  listSkills?(threadId?: string): Promise<SkillCatalogEntry[]>;
  getQuotaToday?(): Promise<QuotaView>;
  setMessageFeedback?(
    messageId: string,
    input: MessageFeedbackInput,
  ): Promise<{ feedback: MessageFeedback | null }>;
}

/** An optional {@link AgentBackend} member the bound backend does not implement was called. */
export class AgentBackendUnsupportedError extends Error {
  constructor(readonly method: string) {
    super(`The agent backend does not implement ${method}()`);
    this.name = 'AgentBackendUnsupportedError';
  }
}

type OptionalMethod = {
  [K in keyof AgentBackend]-?: undefined extends AgentBackend[K] ? K : never;
}[keyof AgentBackend];

/**
 * The optional backend method `name`, bound — or a throw naming it. For hook code that has to call
 * something a backend may not offer.
 */
export function requireBackendMethod<K extends OptionalMethod>(
  backend: AgentBackend,
  name: K,
): NonNullable<AgentBackend[K]> {
  const method = backend[name];
  if (typeof method !== 'function') {
    throw new AgentBackendUnsupportedError(name);
  }
  return (method as (...args: never[]) => unknown).bind(backend) as NonNullable<AgentBackend[K]>;
}
