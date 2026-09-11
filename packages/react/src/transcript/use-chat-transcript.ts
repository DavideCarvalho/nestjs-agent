import type { UIMessage } from 'ai';
import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type ChatStatus,
  type MessageUsageInfo,
  type TimestampInfo,
  type TranscriptBlock,
  type UsageSummary,
  buildTranscriptBlocks,
  describeTimestamp,
  describeUsage,
  extractMessageText,
} from './model.js';
import { type StickToBottom, useStickToBottom } from './use-stick-to-bottom.js';

/** Most-recent messages mounted up front; older ones wait behind `window.loadEarlier`. */
const DEFAULT_VISIBLE_COUNT = 50;
const DEFAULT_LOAD_EARLIER_STEP = 50;
const DEFAULT_COPY_RESET_MS = 1500;

export interface TranscriptCopyState {
  /** False when the message has no prose to put on the clipboard. */
  available: boolean;
  copied: boolean;
  copy: () => void;
}

export interface TranscriptEditState {
  available: boolean;
  isEditing: boolean;
  draft: string;
  /** Whitespace-only drafts are refused, so an empty resubmit can never be sent. */
  canSave: boolean;
  start: () => void;
  cancel: () => void;
  setDraft: (value: string) => void;
  save: () => void;
  /** Controlled-textarea wiring: focus with the caret at the end, Enter saves, Escape cancels. */
  getTextareaProps: () => {
    ref: (element: HTMLTextAreaElement | null) => void;
    value: string;
    onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => void;
    onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  };
}

export interface TranscriptActionState {
  available: boolean;
  run: () => void;
}

export interface TranscriptItem {
  id: string;
  message: UIMessage;
  role: UIMessage['role'];
  /** Index in the FULL message array, not in the rendered window. */
  index: number;
  isUser: boolean;
  isAssistant: boolean;
  isLastAssistant: boolean;
  isStreaming: boolean;
  blocks: TranscriptBlock[];
  /** The prose alone — what `copy` puts on the clipboard and what an edit starts from. */
  text: string;
  usage: UsageSummary | null;
  timestamp: TimestampInfo | null;
  copy: TranscriptCopyState;
  edit: TranscriptEditState;
  fork: TranscriptActionState;
  regenerate: TranscriptActionState;
}

export interface TranscriptItemOptions {
  /** User messages get an inline edit-and-resubmit machine. */
  editable?: boolean;
  onEditSubmit?: (messageId: string, text: string) => void | Promise<void>;
  onFork?: (messageId: string) => void | Promise<void>;
  /** Only the LAST assistant message gets a regenerate machine. */
  regeneratable?: boolean;
  onRegenerate?: (messageId: string) => void | Promise<void>;
  getUsage?: (message: UIMessage) => MessageUsageInfo | null;
  getCreatedAt?: (message: UIMessage) => string | null;
  /** How long `copy.copied` stays true. Default 1500ms. */
  copyResetMs?: number;
  /** Clipboard writer; defaults to `navigator.clipboard.writeText`. */
  writeClipboard?: (text: string) => Promise<void>;
  /**
   * Lift retrieval tool parts into their own `sources` block instead of leaving them in the tool
   * run. Off by default, so a renderer already drawing tool cards keeps drawing them.
   */
  sources?: boolean;
  /**
   * Settle a parked question set — wire to `useAgentChat`'s `answer`. Supplying it is what lifts a
   * question set out of the tool run into an `elicitation` block: without somewhere to send an
   * answer, a form is a card the user cannot act on.
   *
   * `answers` holds ONLY the questions the user touched. An omitted one takes its own pre-picked
   * default server-side, which is what keeps "just confirmed" and "picked exactly what was
   * pre-picked" distinguishable in the settled row.
   */
  onAnswer?: (toolCallId: string, answers: Record<string, string[]>) => void | Promise<void>;
  /** Decline the question set and let the agent proceed on its own picks — `useAgentChat`'s `skip`. */
  onSkip?: (toolCallId: string) => void | Promise<void>;
  /** Settle a tool call parked on a human — `useAgentChat`'s `approve` / `reject`. */
  onApprove?: (toolCallId: string) => void | Promise<void>;
  onReject?: (toolCallId: string) => void | Promise<void>;
}

export interface TranscriptWindow {
  visibleCount: number;
  /** How many older messages are not mounted. */
  hiddenCount: number;
  canLoadEarlier: boolean;
  loadEarlier: () => void;
  showAll: () => void;
}

export interface TranscriptStopState {
  available: boolean;
  /** True from the click until the turn actually leaves a busy status. */
  isStopping: boolean;
  stop: () => void;
}

export interface UseChatTranscriptOptions extends TranscriptItemOptions {
  messages: UIMessage[];
  status: ChatStatus;
  initialVisibleCount?: number;
  loadEarlierStep?: number;
  /** Cancel the in-flight turn — wire to `useAgentChat`'s `cancel`. */
  onStop?: () => void | Promise<void>;
  /** Suggested follow-ups. The model only decides WHETHER they belong on screen. */
  followUps?: string[] | null;
  stickToBottomThreshold?: number;
}

export interface ChatTranscript {
  /** The mounted window, oldest first. `window.hiddenCount` says what is held back. */
  items: TranscriptItem[];
  status: ChatStatus;
  isEmpty: boolean;
  /** A turn is in flight: sent but not settled. */
  isBusy: boolean;
  isStreaming: boolean;
  showEmptyState: boolean;
  /** Waiting on the first token of a turn that has no assistant message yet. */
  showTypingIndicator: boolean;
  showFollowUps: boolean;
  lastAssistantId: string | null;
  window: TranscriptWindow;
  scroll: StickToBottom;
  stop: TranscriptStopState;
}

/**
 * The model behind a chat transcript: messages normalized into items with their parts grouped into
 * runs, per-message derived values (copyable text, usage labels, relative time), each action as a
 * state machine rather than a button, list windowing, and stick-to-bottom. It renders nothing and
 * names no class — `MessageList`/`MessageItem` are one renderer over it, and an app with its own
 * design system writes another without reimplementing any of this.
 */
export function useChatTranscript(options: UseChatTranscriptOptions): ChatTranscript {
  const {
    messages,
    status,
    initialVisibleCount = DEFAULT_VISIBLE_COUNT,
    loadEarlierStep = DEFAULT_LOAD_EARLIER_STEP,
    followUps,
    stickToBottomThreshold,
  } = options;

  const latest = useRef(options);
  latest.current = options;

  const [visibleCount, setVisibleCount] = useState(initialVisibleCount);
  const [stopRequested, setStopRequested] = useState(false);

  const isStreaming = status === 'streaming';
  const isBusy = status === 'submitted' || isStreaming;
  const isEmpty = messages.length === 0;

  // A settled turn clears a pending stop, so the next turn's button starts from rest.
  useEffect(() => {
    if (!isBusy) {
      setStopRequested(false);
    }
  }, [isBusy]);

  const lastMessage = messages.at(-1);
  const lastAssistant = findLastAssistant(messages);
  const streamingMessageId = isStreaming ? (lastAssistant?.id ?? null) : null;

  const visibleStart = Math.max(0, messages.length - visibleCount);
  const items = useTranscriptItems({
    messages,
    visibleStart,
    streamingMessageId,
    options,
  });

  const stop = useCallback(() => {
    const current = latest.current;
    if (current.status !== 'submitted' && current.status !== 'streaming') {
      return;
    }
    setStopRequested(true);
    void current.onStop?.();
  }, []);

  const loadEarlier = useCallback(
    () =>
      setVisibleCount(
        (count) => count + (latest.current.loadEarlierStep ?? DEFAULT_LOAD_EARLIER_STEP),
      ),
    [],
  );
  const showAll = useCallback(() => setVisibleCount(latest.current.messages.length), []);

  const scroll = useStickToBottom({
    contentKey: contentSignature(messages),
    ...(stickToBottomThreshold !== undefined ? { threshold: stickToBottomThreshold } : {}),
  });

  const showTypingIndicator = isBusy && lastMessage?.role !== 'assistant';

  return {
    items,
    status,
    isEmpty,
    isBusy,
    isStreaming,
    showEmptyState: isEmpty && status === 'ready',
    showTypingIndicator,
    showFollowUps:
      status === 'ready' &&
      !showTypingIndicator &&
      lastMessage?.role === 'assistant' &&
      !!followUps &&
      followUps.length > 0,
    lastAssistantId: lastAssistant?.id ?? null,
    window: {
      visibleCount,
      hiddenCount: visibleStart,
      canLoadEarlier: visibleStart > 0,
      loadEarlier,
      showAll,
    },
    scroll,
    stop: {
      available: isBusy && options.onStop !== undefined,
      isStopping: stopRequested,
      stop,
    },
  };
}

export interface UseTranscriptItemOptions extends TranscriptItemOptions {
  message: UIMessage;
  isStreaming?: boolean;
}

/**
 * The single-message half of {@link useChatTranscript}, for a renderer that owns the list itself.
 * `regeneratable` applies directly here: one assistant message is trivially the last one.
 */
export function useTranscriptItem(options: UseTranscriptItemOptions): TranscriptItem {
  const { message, isStreaming = false } = options;
  const messagesRef = useRef<UIMessage[]>([message]);
  // A fresh array each render would re-key nothing but does churn the items memo; the identity is
  // kept stable while the message itself is unchanged.
  if (messagesRef.current[0] !== message) {
    messagesRef.current = [message];
  }
  const items = useTranscriptItems({
    messages: messagesRef.current,
    visibleStart: 0,
    streamingMessageId: isStreaming ? message.id : null,
    options,
  });
  // One message in, exactly one item out.
  return items[0] as TranscriptItem;
}

interface TranscriptItemsParams {
  messages: UIMessage[];
  visibleStart: number;
  streamingMessageId: string | null;
  options: TranscriptItemOptions;
}

/**
 * All per-message UI state lives here, keyed by message id, because the number of messages is not
 * known at render time — a hook per item would break the rules of hooks the moment a turn arrives.
 * Each item's callbacks are cached per id so a controlled `<textarea>`'s ref identity survives every
 * keystroke; without that, React detaches and re-attaches the node on each render and the focus
 * effect drags the caret back to the end mid-edit.
 */
function useTranscriptItems({
  messages,
  visibleStart,
  streamingMessageId,
  options,
}: TranscriptItemsParams): TranscriptItem[] {
  const [drafts, setDrafts] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [copied, setCopied] = useState<ReadonlySet<string>>(() => new Set());
  const [openReasoning, setOpenReasoning] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  // A question's picks, under `toolCallId|questionId`. Presence IS "the user touched this
  // question" — an absent entry is what makes the submission omit it and take the server's default.
  const [picks, setPicks] = useState<ReadonlyMap<string, string[]>>(() => new Map());
  const [settling, setSettling] = useState<ReadonlySet<string>>(() => new Set());
  const [settleErrors, setSettleErrors] = useState<ReadonlyMap<string, string>>(() => new Map());

  const latest = useRef({ options, drafts, picks, messages });
  latest.current = { options, drafts, picks, messages };

  const copyTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(
    () => () => {
      for (const timer of copyTimers.current.values()) {
        clearTimeout(timer);
      }
      copyTimers.current.clear();
    },
    [],
  );

  const callbackCache = useRef(new Map<string, ItemCallbacks>());
  const reasoningToggleCache = useRef(new Map<string, (open?: boolean) => void>());

  const toggleReasoning = useCallback((key: string, open?: boolean) => {
    setOpenReasoning((current) => {
      const next = new Map(current);
      next.set(key, open ?? !(current.get(key) ?? false));
      return next;
    });
  }, []);

  const stableToggle = useCallback(
    (key: string) => {
      let cached = reasoningToggleCache.current.get(key);
      if (!cached) {
        cached = (open?: boolean) => toggleReasoning(key, open);
        reasoningToggleCache.current.set(key, cached);
      }
      return cached;
    },
    [toggleReasoning],
  );

  const pick = useCallback((toolCallId: string, questionId: string, values: string[]) => {
    setPicks((current) => new Map(current).set(pickKey(toolCallId, questionId), values));
  }, []);

  /**
   * Run one decision against the server. A rejection has to land somewhere the user can see: the
   * call stays parked either way, and a form that silently does nothing on submit is
   * indistinguishable from a broken button.
   */
  const settle = useCallback((toolCallId: string, send: () => void | Promise<void>) => {
    setSettleErrors((current) => {
      if (!current.has(toolCallId)) {
        return current;
      }
      const next = new Map(current);
      next.delete(toolCallId);
      return next;
    });
    setSettling((current) => new Set(current).add(toolCallId));
    const failed = (error: unknown) => {
      setSettling((current) => {
        const next = new Set(current);
        next.delete(toolCallId);
        return next;
      });
      setSettleErrors((current) =>
        new Map(current).set(
          toolCallId,
          error instanceof Error ? error.message : 'Could not settle this',
        ),
      );
    };
    // Sent in the click's own tick, not a microtask later — a synchronous throw and a rejected
    // promise are the same failure to the person looking at the form.
    try {
      void Promise.resolve(send()).catch(failed);
    } catch (error) {
      failed(error);
    }
  }, []);

  const answer = useCallback(
    (toolCallId: string) => {
      const current = latest.current;
      const onAnswer = current.options.onAnswer;
      if (!onAnswer) {
        return;
      }
      settle(toolCallId, () => onAnswer(toolCallId, answersFor(current.picks, toolCallId)));
    },
    [settle],
  );

  const skip = useCallback(
    (toolCallId: string) => {
      const onSkip = latest.current.options.onSkip;
      if (onSkip) {
        settle(toolCallId, () => onSkip(toolCallId));
      }
    },
    [settle],
  );

  const approve = useCallback(
    (toolCallId: string) => {
      const onApprove = latest.current.options.onApprove;
      if (onApprove) {
        settle(toolCallId, () => onApprove(toolCallId));
      }
    },
    [settle],
  );

  const reject = useCallback(
    (toolCallId: string) => {
      const onReject = latest.current.options.onReject;
      if (onReject) {
        settle(toolCallId, () => onReject(toolCallId));
      }
    },
    [settle],
  );

  const callbacksFor = useCallback((id: string): ItemCallbacks => {
    const cached = callbackCache.current.get(id);
    if (cached) {
      return cached;
    }
    const textFor = () =>
      extractMessageText(latest.current.messages.find((message) => message.id === id)?.parts);
    const created: ItemCallbacks = {
      copy: () => {
        const text = textFor();
        if (!text) {
          return;
        }
        const write =
          latest.current.options.writeClipboard ??
          ((value: string) => navigator.clipboard.writeText(value));
        void Promise.resolve()
          .then(() => write(text))
          .then(() => {
            setCopied((current) => new Set(current).add(id));
            const existing = copyTimers.current.get(id);
            if (existing) {
              clearTimeout(existing);
            }
            copyTimers.current.set(
              id,
              setTimeout(() => {
                copyTimers.current.delete(id);
                setCopied((current) => {
                  const next = new Set(current);
                  next.delete(id);
                  return next;
                });
              }, latest.current.options.copyResetMs ?? DEFAULT_COPY_RESET_MS),
            );
          })
          .catch(() => {
            // Clipboard can be unavailable (insecure context / denied permission) — fail quietly.
          });
      },
      startEdit: () => {
        const text = textFor();
        setDrafts((current) => new Map(current).set(id, text));
      },
      cancelEdit: () => {
        setDrafts((current) => {
          const next = new Map(current);
          next.delete(id);
          return next;
        });
      },
      setDraft: (value: string) => {
        setDrafts((current) => new Map(current).set(id, value));
      },
      save: () => {
        const next = (latest.current.drafts.get(id) ?? '').trim();
        if (!next) {
          return;
        }
        created.cancelEdit();
        void latest.current.options.onEditSubmit?.(id, next);
      },
      fork: () => {
        void latest.current.options.onFork?.(id);
      },
      regenerate: () => {
        void latest.current.options.onRegenerate?.(id);
      },
      textareaRef: (element: HTMLTextAreaElement | null) => {
        if (!element) {
          return;
        }
        element.focus();
        element.setSelectionRange(element.value.length, element.value.length);
      },
      onTextareaChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => {
        created.setDraft(event.target.value);
      },
      onTextareaKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          created.save();
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          created.cancelEdit();
        }
      },
    };
    callbackCache.current.set(id, created);
    return created;
  }, []);

  const lastAssistantId = findLastAssistant(messages)?.id ?? null;
  const items: TranscriptItem[] = [];

  for (let index = visibleStart; index < messages.length; index++) {
    const message = messages[index];
    if (!message) {
      continue;
    }
    const callbacks = callbacksFor(message.id);
    const draft = drafts.get(message.id);
    const isEditing = draft !== undefined;
    const text = extractMessageText(message.parts);
    const usage = options.getUsage?.(message) ?? null;
    const isUser = message.role === 'user';
    const isAssistant = message.role === 'assistant';
    const isLastAssistant = isAssistant && message.id === lastAssistantId;

    items.push({
      id: message.id,
      message,
      role: message.role,
      index,
      isUser,
      isAssistant,
      isLastAssistant,
      isStreaming: message.id === streamingMessageId,
      blocks: buildTranscriptBlocks(message, {
        isReasoningOpen: (key, isStreamingRun) => openReasoning.get(key) ?? isStreamingRun,
        toggleReasoning: (key, open) => stableToggle(key)(open),
        ...(options.sources !== undefined ? { sources: options.sources } : {}),
        ...(options.onAnswer !== undefined
          ? {
              elicitation: {
                picked: (toolCallId, questionId) => picks.get(pickKey(toolCallId, questionId)),
                pick,
                canAnswer: true,
                canSkip: options.onSkip !== undefined,
                answer,
                skip,
                isSubmitting: (toolCallId) => settling.has(toolCallId),
                errorOf: (toolCallId) => settleErrors.get(toolCallId) ?? null,
              },
            }
          : {}),
        ...(options.onApprove !== undefined || options.onReject !== undefined
          ? {
              approval: {
                canApprove: options.onApprove !== undefined,
                canReject: options.onReject !== undefined,
                approve,
                reject,
                isSubmitting: (toolCallId) => settling.has(toolCallId),
                errorOf: (toolCallId) => settleErrors.get(toolCallId) ?? null,
              },
            }
          : {}),
      }),
      text,
      usage: usage ? describeUsage(usage) : null,
      timestamp: describeTimestamp(options.getCreatedAt?.(message)),
      copy: {
        available: text.length > 0,
        copied: copied.has(message.id),
        copy: callbacks.copy,
      },
      edit: {
        available: isUser && options.editable === true && options.onEditSubmit !== undefined,
        isEditing,
        draft: draft ?? text,
        canSave: (draft ?? '').trim().length > 0,
        start: callbacks.startEdit,
        cancel: callbacks.cancelEdit,
        setDraft: callbacks.setDraft,
        save: callbacks.save,
        getTextareaProps: () => ({
          ref: callbacks.textareaRef,
          value: draft ?? text,
          onChange: callbacks.onTextareaChange,
          onKeyDown: callbacks.onTextareaKeyDown,
        }),
      },
      fork: {
        available: options.onFork !== undefined,
        run: callbacks.fork,
      },
      regenerate: {
        available:
          isLastAssistant && options.regeneratable === true && options.onRegenerate !== undefined,
        run: callbacks.regenerate,
      },
    });
  }

  return items;
}

interface ItemCallbacks {
  copy: () => void;
  startEdit: () => void;
  cancelEdit: () => void;
  setDraft: (value: string) => void;
  save: () => void;
  fork: () => void;
  regenerate: () => void;
  textareaRef: (element: HTMLTextAreaElement | null) => void;
  onTextareaChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => void;
  onTextareaKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
}

/** `|` never appears in either half: a tool-call id and a question id are both opaque tokens. */
function pickKey(toolCallId: string, questionId: string): string {
  return `${toolCallId}|${questionId}`;
}

/** The picks belonging to one question set, as the answers a submission carries. */
function answersFor(
  picks: ReadonlyMap<string, string[]>,
  toolCallId: string,
): Record<string, string[]> {
  const prefix = `${toolCallId}|`;
  const answers: Record<string, string[]> = {};
  for (const [key, values] of picks) {
    if (key.startsWith(prefix)) {
      answers[key.slice(prefix.length)] = values;
    }
  }
  return answers;
}

function findLastAssistant(messages: UIMessage[]): UIMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === 'assistant') {
      return message;
    }
  }
  return undefined;
}

/**
 * Changes as the transcript grows, including WITHIN the message being streamed — the array is
 * mutated in place while tokens arrive, so its length alone never moves during a turn.
 */
function contentSignature(messages: UIMessage[]): string {
  const last = messages.at(-1);
  if (!last) {
    return '0';
  }
  let length = 0;
  for (const part of last.parts ?? []) {
    if ('text' in part && typeof part.text === 'string') {
      length += part.text.length;
    }
  }
  return `${messages.length}|${last.id}|${last.parts?.length ?? 0}|${length}`;
}
