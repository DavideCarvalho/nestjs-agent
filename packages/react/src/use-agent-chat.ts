import { useChat } from '@ai-sdk/react';
import type {
  QuotaBlock,
  StoredMessage,
  ThreadDetail,
  ThreadSummary,
} from '@dudousxd/nestjs-agent-core';
import type { DataUIPart, UIDataTypes, UIMessage } from 'ai';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AgentChatTransport,
  type AgentStreamMeta,
  type ReconnectOptions,
  type StreamConnectionState,
} from './agent-chat-transport.js';
import {
  type AttachmentsState,
  type UseAttachmentsOptions,
  useAttachments,
} from './attachments/use-attachments.js';
import { type AgentBackend, requireBackendMethod } from './backend.js';
import { type BackgroundRun, backgroundRunsFromThread } from './background-runs.js';
import { type ModelOption, type ModelsState, useModels } from './catalog/use-models.js';
import { useToolCatalog } from './presentation/use-tool-catalog.js';
import { useAgentBackend } from './provider.js';
import { type QuotaState, useQuota } from './quota/use-quota.js';
import { storedMessageToUiMessage } from './stored-message-to-ui-message.js';
import {
  type AgentMessageMetadata,
  storedThreadToUiMessages,
} from './stored-thread-to-ui-messages.js';
import { notifyThreads } from './threads/threads-events.js';
import type { ChatStatus } from './transcript/model.js';
import {
  type AnswerInput,
  type ApproveInput,
  type ChatTranscript,
  type MessageActionInput,
  type RejectInput,
  type SkipInput,
  type UseChatTranscriptOptions,
  useChatTranscript,
} from './transcript/use-chat-transcript.js';

export interface UseAgentChatOptions<B extends AgentBackend = AgentBackend> {
  /**
   * What the chat talks to — see {@link AgentBackend}. Omitted → the enclosing `<AgentProvider>`'s,
   * else a same-origin client on `/agent`. Must be stable across renders.
   */
  backend?: B;
  /**
   * Retry a stream that dropped mid-run from its last frame (`GET <base>/chat/:runId/stream?after=`),
   * with exponential backoff. `status` reads `'reconnecting'` meanwhile. Default on; `false` turns
   * it off.
   */
  reconnect?: ReconnectOptions | false;
  /** Named agent to run each turn. */
  agent?: string;
  /**
   * Thread this chat is bound to. Omitted → the backend creates one on the first send
   * ({@link UseAgentChatOptions.onThreadCreated}). Changing it switches the chat to that thread:
   * its history loads and a turn still streaming on it is re-attached. Switching to the thread this
   * chat just created (syncing a URL) keeps the live conversation as it is.
   */
  threadId?: string;
  /**
   * Load a `threadId`'s persisted history into the chat (`GET <base>/threads/:id`). Default `true`;
   * skipped when {@link UseAgentChatOptions.initialMessages} is given. `false` opts out.
   */
  history?: boolean;
  /** Persisted history you already have — seeds the chat instead of loading it (read per thread). */
  initialMessages?: UIMessage[];
  /**
   * Re-attach to a turn that was still streaming on `threadId` when the page (re)loaded — read off
   * the thread's `activeRunId`, so a reload mid-answer keeps streaming it. Default `true`; `false`
   * opts out.
   */
  resume?: boolean;
  /**
   * A run id you already know is streaming — attached to on mount without reading the thread first.
   * Rarely needed: {@link UseAgentChatOptions.resume} finds it by itself.
   */
  resumeRunId?: string;
  /**
   * The model every turn runs on, controlled by you. Omitted → `chat.models.selected` (what
   * `chat.models.select(id)` picked), else the thread's pinned model, else the server default. A
   * single send can still override it with `sendMessage(msg, { body: { model } })`.
   */
  model?: string;
  /**
   * Read the caller's budget (`GET <base>/quota`) and refuse sends while a window is exhausted.
   * Default `true` when the backend implements `getQuota`; `false` skips the request.
   */
  quota?: boolean;
  /**
   * Override the quota gate: `null` never blocks, a {@link QuotaBlock} always does. Omitted → the
   * gate follows {@link UseAgentChatOptions.quota}'s report. While blocked, `sendMessage` and
   * `regenerate` refuse with {@link QuotaBlockedError}.
   */
  blocked?: QuotaBlock | null;
  /** Validation and upload for `chat.composer.files` — see `useAttachments`. */
  composer?: Omit<UseAttachmentsOptions, 'backend'>;
  /**
   * Overrides for `chat.transcript` — anything `useChatTranscript` takes (`sources`, `editable` +
   * `onEditSubmit`, `followUps`, `getUsage`, a `toolCatalog` of your own, `onApprove: null`, …).
   * Yours win over the chat's own wiring.
   */
  transcript?: Partial<Omit<UseChatTranscriptOptions, 'messages' | 'status'>>;
  /** Read at every send to capture a page snapshot for the page-assistant. */
  getPageContext?: () => Record<string, unknown> | null;
  /** Fired after each streamed turn finishes (e.g. to refetch the sidebar). */
  onFinish?: () => void;
  /**
   * Fired when this chat moves to a thread it created: the first send of a threadless chat (the
   * backend created one), or `chat.fork(…)`. Carries the id so the host can sync its URL/router.
   * The hook already remembers a created thread, so every later send reuses it even before the
   * host navigates.
   */
  onThreadCreated?: (threadId: string) => void;
  /**
   * Fired exactly once per run when its stream settles — normally (`'completed'`) or via a thrown
   * failure / the backend's `event: error` frame (`'failed'`) — including a RESUMED stream's own
   * completion. By the time this fires, the server has already derived and persisted the thread's
   * title (and the run's terminal state).
   *
   * Skipped when the attempt never got far enough to learn a run id. A user-initiated `cancel()`
   * reports `'completed'` (the server-side cancel records its own terminal state).
   */
  onRunSettled?: (outcome: { runId: string; status: 'completed' | 'failed' }) => void;
  /**
   * Every data part the stream delivers, as it arrives — including transient ones that are never
   * stored on a message (`data-title`, `data-cancelled`). Pushed components arrive as `data-ui`,
   * approval metadata as `data-approval-requested`, and a frame kind this version does not map as
   * `data-<kind>`. See `AgentChatTransport` for the full mapping.
   */
  onData?: (part: DataUIPart<UIDataTypes>) => void;
  /** The server set or changed the thread's title while a turn streamed. */
  onTitle?: (title: string) => void;
  /**
   * Track DETACHED sub-agents this conversation started: which are still working, and their answers
   * as they land (see {@link ChatBackground}). Default `false`.
   */
  background?: boolean;
  /**
   * How often to re-read the thread while a detached sub-agent is still working, in ms. Default
   * 5000; `0` turns the interval off, leaving {@link ChatBackground.refresh} as the only trigger.
   */
  backgroundPollMs?: number;
}

/** Sub-agents this conversation started and did not wait for. See {@link BackgroundRun}. */
export interface ChatBackground {
  runs: BackgroundRun[];
  /** True while any of them is still working — what a "2 agents running" affordance reads. */
  isWorking: boolean;
  /** Re-read the thread now, instead of waiting for the next poll. */
  refresh: () => Promise<void>;
}

/** The chat's model picker state. Loaded the first time `list`/`providers` is read. */
export interface ChatModels {
  /** Every model the caller may pick, flattened (`[]` until loaded). */
  readonly list: ModelOption[];
  /** The same, grouped by provider. */
  readonly providers: ModelsState['providers'];
  /** What the next turn runs on: the `model` option, the pick, the thread's pin, else the default. */
  selected: string | null;
  /** Run the following turns on `id` (sent as the body's `model`). */
  select: (id: string) => void;
  /**
   * Pin `id` on the thread (`null` unpins) — every later turn without its own `model` runs on it,
   * across reloads. On a chat with no thread yet, the pin lands when the first send creates one.
   */
  pinToThread: (id: string | null) => Promise<void>;
  isLoading: boolean;
  error: Error | null;
}

/** Why the composer cannot send right now. */
export type ComposerBlock = 'empty' | 'busy' | 'uploading' | 'quota';

/** A headless composer: the draft, its files, and whether (and why not) it can send. */
export interface ChatComposer {
  text: string;
  setText: (text: string) => void;
  /** The staged attachments — `useAttachments` state on the chat's backend. */
  files: AttachmentsState;
  canSend: boolean;
  /** Why `canSend` is false, or `null`. */
  blockedBy: ComposerBlock | null;
  /** Send the draft with the ready files attached, then clear both. A no-op while blocked. */
  submit: () => Promise<void>;
}

interface AddToolResultArgs {
  tool: string;
  toolCallId: string;
  output: unknown;
}

let localChatSequence = 0;
function localChatId(): string {
  localChatSequence += 1;
  return `local-chat-${localChatSequence}`;
}

/**
 * The agent chat, wired: the AI SDK v7 `useChat` over `AgentChatTransport`, a thread's history
 * loaded and a streaming turn re-attached on its own, a quota send gate, a model picker, a headless
 * composer with attachments, and a transcript whose approve/reject/answer/skip/stop/fork/regenerate
 * are already bound. Every piece is also a hook of its own (`useChatTranscript`, `useAttachments`,
 * `useModels`, `useQuota`, `useThreads`) for a host that wants to wire it differently.
 */
export function useAgentChat<B extends AgentBackend = AgentBackend>(
  options: UseAgentChatOptions<B> = {},
) {
  const latest = useRef(options);
  latest.current = options;

  // Identity-stable: the first backend this chat mounted with is the one it keeps.
  const resolved = useAgentBackend<B>(options.backend);
  const client = useRef(resolved).current;

  // The thread the backend created for a threadless chat (or a fork moved to), captured from the
  // `meta` frame. Every send after the first reuses it; an explicit `threadId` option always wins.
  const createdThreadId = useRef<string | undefined>(undefined);

  // Which conversation `useChat` holds. A new `threadId` is a different conversation — except the
  // one this chat itself created, which a host passes back once it syncs its URL.
  const chatIdRef = useRef<string>(options.threadId ?? localChatId());
  const boundThreadRef = useRef(options.threadId);
  if (options.threadId !== boundThreadRef.current) {
    boundThreadRef.current = options.threadId;
    const adopting = options.threadId !== undefined && options.threadId === createdThreadId.current;
    if (!adopting) {
      chatIdRef.current = options.threadId ?? localChatId();
      createdThreadId.current = undefined;
    }
  }
  const chatId = chatIdRef.current;

  const [runId, setRunId] = useState<string | undefined>(options.resumeRunId);
  const runIdRef = useRef<string | undefined>(runId);
  runIdRef.current = runId;

  // The run id learned (via the `meta` frame) during the CURRENT in-flight attempt only — reset by
  // the transport's `onAttemptStart`. `onRunSettled` reads THIS so an attempt that fails before
  // learning a run id never misattributes its outcome to the previous run.
  const settlingRunIdRef = useRef<string | undefined>(undefined);

  // The run id discovered from the thread's `activeRunId`, read by the transport's
  // `getResumeRunId` alongside the explicit `resumeRunId` option.
  const autoResumeRunIdRef = useRef<string | undefined>(undefined);
  // The loaded thread's active run, if any — `null` once read with none.
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [historyError, setHistoryError] = useState<Error | null>(null);
  // The model pinned on the loaded thread.
  const [threadModel, setThreadModel] = useState<string | null>(null);
  const [pickedModel, setPickedModel] = useState<string | undefined>(undefined);
  const pickedModelRef = useRef(pickedModel);
  pickedModelRef.current = pickedModel;
  // A pin asked for before the chat had a thread — sent once the first send creates one.
  const pendingPin = useRef<{ model: string | null } | undefined>(undefined);

  // One-shot flag read (and cleared) by the transport's getBody so the next send carries
  // `regenerate: true` — telling the backend to re-run the last exchange instead of appending.
  const regenerateNext = useRef(false);

  const currentThreadId = useCallback(
    (): string | undefined => latest.current.threadId ?? createdThreadId.current,
    [],
  );

  // Where the live stream stands — `reconnecting` while the transport retries a dropped one.
  const [connection, setConnection] = useState<StreamConnectionState>({ status: 'live' });
  // The run ended while the stream was away: what streamed is incomplete, the thread is not.
  const resyncAfterSettle = useRef(false);

  // Identity-stable: per-render config is read through `latest`.
  // biome-ignore lint/correctness/useExhaustiveDependencies: stable by design
  const transport = useMemo(() => {
    function onMeta(meta: AgentStreamMeta): void {
      settlingRunIdRef.current = meta.runId;
      setRunId(meta.runId);
      if (
        latest.current.threadId === undefined &&
        meta.threadId &&
        createdThreadId.current !== meta.threadId
      ) {
        createdThreadId.current = meta.threadId;
        const pin = pendingPin.current;
        if (pin !== undefined) {
          pendingPin.current = undefined;
          void client.updateThread(meta.threadId, { model: pin.model }).catch(() => undefined);
        }
        latest.current.onThreadCreated?.(meta.threadId);
        notifyThreads(client, { type: 'changed' });
      }
    }
    return new AgentChatTransport({
      backend: client,
      ...(options.reconnect !== undefined ? { reconnect: options.reconnect } : {}),
      onConnectionChange: (state) => {
        if (state.status === 'gone') resyncAfterSettle.current = true;
        setConnection(state.status === 'gone' ? { status: 'live' } : state);
      },
      ...(options.agent !== undefined ? { agent: options.agent } : {}),
      getBody: () => {
        const current = latest.current;
        const pageContext = current.getPageContext?.() ?? null;
        const regenerate = regenerateNext.current;
        regenerateNext.current = false;
        const threadId = currentThreadId();
        const model = current.model ?? pickedModelRef.current;
        return {
          // Read per send: a host that switches agents before the first message (a picker on a
          // new chat) sends the one picked now, not the one this chat mounted with.
          ...(current.agent !== undefined ? { agent: current.agent } : {}),
          ...(threadId !== undefined ? { threadId } : {}),
          ...(model !== undefined ? { model } : {}),
          ...(pageContext ? { pageContext } : {}),
          ...(regenerate ? { regenerate: true } : {}),
        };
      },
      getResumeRunId: () => latest.current.resumeRunId ?? autoResumeRunIdRef.current,
      onMeta,
      onAttemptStart: () => {
        settlingRunIdRef.current = undefined;
      },
    });
  }, []);

  // Assigned once `refreshBackground` exists below.
  const backgroundRef = useRef<() => Promise<void>>(() => Promise.resolve());

  const chat = useChat({
    transport,
    id: chatId,
    resume: options.resumeRunId !== undefined,
    ...(options.initialMessages !== undefined ? { messages: options.initialMessages } : {}),
    onData: (part) => {
      latest.current.onData?.(part);
      if (part.type === 'data-title') {
        const title = (part.data as { title?: unknown } | null)?.title;
        if (typeof title === 'string') {
          latest.current.onTitle?.(title);
          const threadId = currentThreadId();
          if (threadId !== undefined) notifyThreads(client, { type: 'title', threadId, title });
        }
      }
    },
    onFinish: ({ isError }) => {
      latest.current.onFinish?.();
      if (latest.current.background === true) {
        void backgroundRef.current();
      }
      const settledRunId = settlingRunIdRef.current;
      if (settledRunId !== undefined) {
        latest.current.onRunSettled?.({
          runId: settledRunId,
          status: isError ? 'failed' : 'completed',
        });
        notifyThreads(client, { type: 'changed' });
      }
      setConnection({ status: 'live' });
      if (resyncAfterSettle.current) {
        resyncAfterSettle.current = false;
        void resyncFromThread();
      }
    },
  });

  const chatRef = useRef(chat);
  chatRef.current = chat;

  /** Replace the transcript with the persisted thread — after a run finished while we were away. */
  async function resyncFromThread(): Promise<void> {
    const threadId = currentThreadId();
    if (threadId === undefined) return;
    try {
      const thread = await client.getThread(threadId);
      chatRef.current.setMessages(storedThreadToUiMessages(thread.messages));
    } catch {
      /* best-effort: the partial answer stays until the next load */
    }
  }

  // A new conversation starts from rest: nothing of the previous thread's run state carries over.
  const firstChatId = useRef(chatId);
  useEffect(() => {
    if (chatId === firstChatId.current) return;
    firstChatId.current = chatId;
    setRunId(undefined);
    setActiveRunId(null);
    setThreadModel(null);
    setBackgroundRuns([]);
    setHistoryError(null);
    autoResumeRunIdRef.current = undefined;
    pendingPin.current = undefined;
  }, [chatId]);

  // A thread's history and its still-streaming turn, in one read. Re-runs per conversation; a
  // stale response (the thread changed mid-flight) is dropped.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `chatId` names the conversation
  useEffect(() => {
    const threadId = options.threadId;
    if (threadId === undefined) return;
    // Adopted: this chat created the thread, and its messages are the live ones.
    if (threadId === createdThreadId.current) return;
    const current = latest.current;
    const wantHistory = current.history !== false && current.initialMessages === undefined;
    const wantResume = current.resume !== false && current.resumeRunId === undefined;
    if (!wantHistory && !wantResume) return;
    let cancelled = false;
    if (wantHistory) setIsLoadingHistory(true);
    client
      .getThread(threadId)
      .then(
        (thread: ThreadDetail | undefined) => {
          if (cancelled || thread == null) return;
          const active = thread.activeRunId ?? null;
          const stored = Array.isArray(thread.messages) ? thread.messages : [];
          setActiveRunId(active);
          setThreadModel(thread.model ?? null);
          setHistoryError(null);
          const resuming = wantResume && active !== null;
          if (wantHistory && chatRef.current.messages.length === 0) {
            // The run being resumed replays from its first frame, so its rows are left to the stream.
            const rows = resuming
              ? stored.filter(
                  (message: StoredMessage) =>
                    !(message.role === 'assistant' && message.runId === active),
                )
              : stored;
            chatRef.current.setMessages(storedThreadToUiMessages(rows));
          }
          if (resuming) {
            autoResumeRunIdRef.current = active;
            void chatRef.current.resumeStream();
          }
        },
        (error: unknown) => {
          if (cancelled) return;
          setHistoryError(error instanceof Error ? error : new Error(String(error)));
        },
      )
      .finally(() => {
        if (!cancelled) setIsLoadingHistory(false);
      });
    return () => {
      cancelled = true;
      setIsLoadingHistory(false);
    };
  }, [client, chatId, options.threadId]);

  /**
   * One turn in flight per chat. The SDK commits its single in-flight response BEFORE it reaches
   * the transport, so a second overlapping turn cannot be untangled downstream. The ref rather than
   * `chat.status`: a double-submitted composer arrives in the same tick, before status moves.
   */
  const turnInFlight = useRef(false);
  const isTurnInFlight = useCallback(
    () => turnInFlight.current || transport.isAttemptLive,
    [transport],
  );

  // ---- quota ---------------------------------------------------------------------------------
  const quota: QuotaState = useQuota({
    backend: client,
    enabled: options.quota !== false && typeof client.getQuota === 'function',
  });
  const blocked: QuotaBlock | null =
    options.blocked !== undefined ? options.blocked : quota.blocked;
  const blockedRef = useRef(blocked);
  blockedRef.current = blocked;

  type SdkSendMessage = typeof chat.sendMessage;
  const sendMessage = useCallback<SdkSendMessage>(
    async (...args: Parameters<SdkSendMessage>) => {
      const block = blockedRef.current;
      if (block != null) throw new QuotaBlockedError(block);
      if (isTurnInFlight()) return;
      turnInFlight.current = true;
      try {
        await chatRef.current.sendMessage(...args);
      } finally {
        turnInFlight.current = false;
      }
    },
    [isTurnInFlight],
  );

  // chat.addToolResult is generic over the backend's tool registry, which we don't statically type
  // here. Expose a string-keyed adapter and narrow once at the SDK boundary.
  type SdkAddToolResult = typeof chat.addToolResult;
  type SdkArgs = Parameters<SdkAddToolResult>[0];
  const addToolResult = useCallback(
    ({ tool, toolCallId, output }: AddToolResultArgs) =>
      chatRef.current.addToolResult({
        tool,
        toolCallId,
        output,
      } as unknown as SdkArgs),
    [],
  );

  // ---- background runs -----------------------------------------------------------------------
  const [backgroundRuns, setBackgroundRuns] = useState<BackgroundRun[]>([]);

  /** Re-derive what is running in the background, and pull in anything that has landed since. */
  const refreshBackground = useCallback(async (): Promise<void> => {
    const threadId = currentThreadId();
    if (threadId === undefined) {
      return;
    }
    const thread = await client.getThread(threadId);
    const runs = backgroundRunsFromThread(thread.messages);
    setBackgroundRuns(runs);
    const landed = runs
      .map((run) => run.message)
      .filter((message): message is NonNullable<typeof message> => message !== undefined);
    if (landed.length === 0) {
      return;
    }
    // Appended rather than re-seeding the list: the session's own messages hold live stream state
    // that the persisted rows do not carry.
    chatRef.current.setMessages((current) => {
      const known = new Set(current.map((message) => message.id));
      const missing = landed.filter((message) => !known.has(message.id));
      return missing.length === 0
        ? current
        : [...current, ...missing.map((message) => storedMessageToUiMessage(message))];
    });
  }, [client, currentThreadId]);

  backgroundRef.current = refreshBackground;

  const isWorking = backgroundRuns.some((run) => run.status === 'running');

  // biome-ignore lint/correctness/useExhaustiveDependencies: `chatId` names the conversation
  useEffect(() => {
    if (options.background !== true || options.threadId === undefined) {
      return;
    }
    void refreshBackground();
  }, [options.background, options.threadId, chatId, refreshBackground]);

  useEffect(() => {
    const every = latest.current.backgroundPollMs ?? 5000;
    if (latest.current.background !== true || !isWorking || every <= 0) {
      return;
    }
    const timer = setInterval(() => void refreshBackground(), every);
    return () => clearInterval(timer);
  }, [isWorking, refreshBackground]);

  // ---- actions -------------------------------------------------------------------------------
  const cancel = useCallback(async (): Promise<void> => {
    // Close the SSE on the client first so the UI flips out of streaming, then hard-abort
    // server-side (a late terminal step can outlive the connection close alone).
    chatRef.current.stop();
    const active = runIdRef.current;
    if (active) {
      try {
        await client.cancelStream(active);
      } catch {
        /* best-effort — the SDK stop already flipped the UI */
      }
    }
  }, [client]);

  // Approve / reject / answer / skip route by tool-call id alone — the server derives the run
  // awaiting it (a sub-agent's own run when the call belongs to a delegated agent).
  const approve = useCallback(
    async ({ toolCallId, remember, via }: ApproveInput): Promise<void> => {
      await requireBackendMethod(
        client,
        'approveToolCall',
      )({
        toolCallId,
        ...(remember === true ? { remember: true } : {}),
        ...(via !== undefined ? { via } : {}),
      });
    },
    [client],
  );

  const reject = useCallback(
    async ({ toolCallId, reason, via }: RejectInput): Promise<void> => {
      await requireBackendMethod(
        client,
        'rejectToolCall',
      )({
        toolCallId,
        ...(reason !== undefined ? { reason } : {}),
        ...(via !== undefined ? { via } : {}),
      });
    },
    [client],
  );

  const answer = useCallback(
    async ({ toolCallId, answers }: AnswerInput): Promise<void> => {
      await requireBackendMethod(
        client,
        'answerToolCall',
      )({
        toolCallId,
        ...(answers !== undefined ? { answers } : {}),
      });
    },
    [client],
  );

  const skip = useCallback(
    async ({ toolCallId }: SkipInput): Promise<void> => {
      await requireBackendMethod(client, 'skipToolCall')({ toolCallId });
    },
    [client],
  );

  // Re-run the last exchange: flag the next request as a regenerate (so the backend truncates and
  // re-answers instead of appending) and let the SDK re-issue it.
  const regenerate = useCallback(
    (_input?: Partial<MessageActionInput>): void => {
      const block = blockedRef.current;
      if (block != null) throw new QuotaBlockedError(block);
      if (isTurnInFlight()) return;
      regenerateNext.current = true;
      turnInFlight.current = true;
      void chatRef.current.regenerate().finally(() => {
        turnInFlight.current = false;
      });
    },
    [isTurnInFlight],
  );

  /**
   * The persisted id of a message on screen. A message streamed in this session carries the
   * client's own id, so the row it became is found by the run that wrote it.
   */
  const storedIdOf = useCallback(
    async (messageId: string, threadId: string): Promise<string> => {
      const message = chatRef.current.messages.find((candidate) => candidate.id === messageId);
      const runOf = (message?.metadata as AgentMessageMetadata | undefined)?.runId;
      if (runOf === undefined) return messageId;
      const thread = await client.getThread(threadId);
      const row = [...thread.messages]
        .reverse()
        .find((candidate) => candidate.role === 'assistant' && candidate.runId === runOf);
      return row?.id ?? messageId;
    },
    [client],
  );

  /**
   * Branch the conversation at `messageId` into a new thread (`onThreadCreated` gets its id).
   * Defaults to this chat's thread.
   */
  const fork = useCallback(
    async ({
      messageId,
      threadId,
    }: MessageActionInput & { threadId?: string }): Promise<ThreadSummary> => {
      const source = threadId ?? currentThreadId();
      if (source === undefined) throw new Error('fork: this chat has no thread yet');
      const stored = await storedIdOf(messageId, source);
      const forked = await requireBackendMethod(client, 'forkFromMessage')(source, stored);
      notifyThreads(client, { type: 'changed' });
      latest.current.onThreadCreated?.(forked.id);
      return forked;
    },
    [client, currentThreadId, storedIdOf],
  );

  /** Delete `messageId` and everything after it on the thread (default: this chat's). */
  const truncateFrom = useCallback(
    async ({ messageId, threadId }: MessageActionInput & { threadId?: string }): Promise<void> => {
      const target = threadId ?? currentThreadId();
      if (target === undefined) throw new Error('truncateFrom: this chat has no thread yet');
      const stored = await storedIdOf(messageId, target);
      await requireBackendMethod(client, 'truncateFromMessage')(target, stored);
    },
    [client, currentThreadId, storedIdOf],
  );

  /** Make a transient thread (default: this chat's) a regular one, listed by `useThreads`. */
  const promote = useCallback(
    async ({ threadId }: { threadId?: string } = {}): Promise<void> => {
      const target = threadId ?? currentThreadId();
      if (target === undefined) throw new Error('promote: this chat has no thread yet');
      await requireBackendMethod(client, 'promoteThread')(target);
      notifyThreads(client, { type: 'changed' });
    },
    [client, currentThreadId],
  );

  // ---- models --------------------------------------------------------------------------------
  const [modelsWanted, setModelsWanted] = useState(false);
  const modelsWantedRef = useRef(modelsWanted);
  modelsWantedRef.current = modelsWanted;
  const catalog = useModels({
    backend: client,
    ...(options.agent !== undefined ? { agent: options.agent } : {}),
    enabled: modelsWanted && typeof client.listModels === 'function',
  });
  const wantModels = useCallback(() => {
    if (modelsWantedRef.current) return;
    modelsWantedRef.current = true;
    // After render: the getter may be read while a child renders.
    queueMicrotask(() => setModelsWanted(true));
  }, []);
  const selectModel = useCallback((id: string) => setPickedModel(id), []);
  const pinToThread = useCallback(
    async (model: string | null): Promise<void> => {
      const threadId = currentThreadId();
      setThreadModel(model);
      if (threadId === undefined) {
        pendingPin.current = { model };
        return;
      }
      await client.updateThread(threadId, { model });
      notifyThreads(client, { type: 'changed' });
    },
    [client, currentThreadId],
  );
  const models: ChatModels = {
    get list() {
      wantModels();
      return catalog.models;
    },
    get providers() {
      wantModels();
      return catalog.providers;
    },
    selected: options.model ?? pickedModel ?? threadModel ?? catalog.defaultModel ?? null,
    select: selectModel,
    pinToThread,
    isLoading: modelsWanted && catalog.isLoading,
    error: catalog.error,
  };

  // A dropped stream the transport is retrying reads as its own status; every other moment is the
  // SDK's. `reconnecting` is still a busy status to the transcript model (see `ChatStatus`).
  const status: ChatStatus = connection.status === 'reconnecting' ? 'reconnecting' : chat.status;
  const isBusy = status === 'submitted' || status === 'streaming' || status === 'reconnecting';

  // ---- composer ------------------------------------------------------------------------------
  const files = useAttachments({ ...options.composer, backend: client });
  const [text, setText] = useState('');
  const blockedBy: ComposerBlock | null =
    blocked != null
      ? 'quota'
      : files.isUploading
        ? 'uploading'
        : isBusy
          ? 'busy'
          : text.trim().length === 0 && files.refs.length === 0
            ? 'empty'
            : null;
  const composerRef = useRef({ text, files, blockedBy });
  composerRef.current = { text, files, blockedBy };
  const submit = useCallback(async (): Promise<void> => {
    const current = composerRef.current;
    if (current.blockedBy !== null) return;
    const refs = current.files.refs;
    // The sent message shows its files right away, as the reloaded thread will (`messageFiles`).
    const files = current.files.items.flatMap((item) =>
      item.status === 'ready' && item.attachment !== undefined
        ? [
            {
              type: 'file' as const,
              mediaType: item.attachment.contentType,
              filename: item.attachment.name,
              url: item.attachment.url,
              providerMetadata: { agent: { mediaId: item.attachment.mediaId } },
            },
          ]
        : [],
    );
    const draft = current.text.trim();
    setText('');
    current.files.clear();
    await sendMessage(
      files.length > 0 ? { text: draft, files } : { text: draft },
      refs.length > 0 ? { body: { attachments: refs } } : undefined,
    );
  }, [sendMessage]);
  const composer: ChatComposer = {
    text,
    setText,
    files,
    canSend: blockedBy === null,
    blockedBy,
    submit,
  };

  // ---- transcript ----------------------------------------------------------------------------
  const ownCatalog = options.transcript?.toolCatalog;
  const tools = useToolCatalog({
    backend: client,
    ...(options.agent !== undefined ? { agent: options.agent } : {}),
    enabled: ownCatalog === undefined && typeof client.listTools === 'function',
  });
  const canFork = typeof client.forkFromMessage === 'function';
  const transcript: ChatTranscript = useChatTranscript({
    messages: chat.messages,
    status,
    onStop: cancel,
    onApprove: approve,
    onReject: reject,
    onAnswer: answer,
    onSkip: skip,
    regeneratable: true,
    onRegenerate: regenerate,
    ...(canFork
      ? { onFork: (input: MessageActionInput) => fork(input).then(() => undefined) }
      : {}),
    ...(ownCatalog === undefined ? { toolCatalog: tools.catalog } : {}),
    ...options.transcript,
  });

  const background: ChatBackground = {
    runs: backgroundRuns,
    isWorking,
    refresh: refreshBackground,
  };

  return {
    ...chat,
    status,
    /** Where the live stream stands — see {@link StreamConnectionState}. */
    connection,
    sendMessage,
    addToolResult,
    /** Sub-agents this conversation started and did not wait for. */
    background,
    runId,
    /** The loaded thread's running turn, or `null` once read with none. */
    activeRunId,
    /** The thread's history is being read. */
    isLoadingHistory,
    /** Reading the thread's history failed. */
    historyError,
    /**
     * The thread this chat is on right now: the `threadId` option, else the one the backend created
     * on the first send. A getter, because the created id is learned mid-stream.
     */
    getThreadId: currentThreadId,
    /** The backend this chat talks to — the same one every other hook under the provider uses. */
    backend: client,
    /** The transcript model, with every action already bound to this chat. */
    transcript,
    /** A headless composer: draft, files, send gate, `submit()`. */
    composer,
    /** The model picker: `list`, `selected`, `select(id)`, `pinToThread(id)`. */
    models,
    /** The caller's budget (`GET <base>/quota`); `quota.blocked` gates sends. */
    quota,
    /** The window blocking sends right now (the `blocked` option, else the quota report's). */
    blocked,
    cancel,
    approve,
    reject,
    answer,
    skip,
    regenerate,
    fork,
    truncateFrom,
    promote,
  };
}

/** A send refused on the client because a quota window is exhausted. */
export class QuotaBlockedError extends Error {
  constructor(readonly block: QuotaBlock) {
    super(block.reason ?? `The ${block.period === 'day' ? 'daily' : 'monthly'} quota is used up`);
    this.name = 'QuotaBlockedError';
  }
}
