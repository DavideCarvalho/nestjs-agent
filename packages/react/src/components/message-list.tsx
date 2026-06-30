import type { UIMessage } from 'ai';
import React, { useState } from 'react';
import {
  MessageItem,
  type MessageItemClassNames,
  type RenderTextFn,
  type RenderToolPartFn,
} from './message-item.js';

export type ChatStatus = 'ready' | 'submitted' | 'streaming' | 'error';

/** Default number of most-recent messages mounted; older load on demand. */
const DEFAULT_VISIBLE_COUNT = 50;
const LOAD_EARLIER_STEP = 50;

export interface MessageListClassNames {
  root?: string;
  empty?: string;
  loadEarlier?: string;
  typing?: string;
  error?: string;
  errorRetry?: string;
  followUps?: string;
  followUpChip?: string;
  message?: MessageItemClassNames;
}

export interface MessageListProps {
  messages: UIMessage[];
  status: ChatStatus;
  renderToolPart?: RenderToolPartFn;
  renderText?: RenderTextFn;
  /** Shown (with example/follow-up chips) when idle and empty. */
  emptyState?: React.ReactNode;
  /** Node rendered while waiting for the first assistant token. */
  typingIndicator?: React.ReactNode;
  /** AI-generated follow-up prompts under the last assistant message. */
  followUps?: string[] | null;
  onFollowUpClick?: (text: string) => void;
  /** Last turn's error — paired with `onRetry`, renders a retry banner. */
  error?: Error | null;
  onRetry?: () => void | Promise<void>;
  classNames?: MessageListClassNames;
}

/**
 * Styling-agnostic message list. Keeps the proven UX — windowed render
 * with "load earlier", a typing indicator, an inline error+retry banner,
 * and follow-up chips — but ships no styles: drive everything through
 * `classNames` and the `emptyState`/`typingIndicator` slots.
 */
export function MessageList({
  messages,
  status,
  renderToolPart,
  renderText,
  emptyState,
  typingIndicator,
  followUps,
  onFollowUpClick,
  error,
  onRetry,
  classNames,
}: MessageListProps) {
  const [visibleCount, setVisibleCount] = useState(DEFAULT_VISIBLE_COUNT);

  if (messages.length === 0 && status === 'ready') {
    return <div className={classNames?.empty}>{emptyState}</div>;
  }

  const lastMessage = messages.at(-1);
  const showTypingBubble =
    (status === 'submitted' || status === 'streaming') &&
    lastMessage?.role !== 'assistant';

  const showFollowUps =
    status === 'ready' &&
    !showTypingBubble &&
    lastMessage?.role === 'assistant' &&
    onFollowUpClick !== undefined &&
    !!followUps &&
    followUps.length > 0;

  // Mount only the tail; "Load earlier" reveals older chunks — critical
  // for long threads where mounting every markdown-rendered message would
  // lock the main thread during streaming.
  const visibleStart = Math.max(0, messages.length - visibleCount);
  const visibleMessages = messages.slice(visibleStart);
  const hiddenCount = visibleStart;

  let lastAssistantIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'assistant') {
      lastAssistantIndex = i;
      break;
    }
  }

  return (
    <div className={classNames?.root}>
      {hiddenCount > 0 ? (
        <button
          type="button"
          className={classNames?.loadEarlier}
          onClick={() => setVisibleCount((count) => count + LOAD_EARLIER_STEP)}
        >
          Load earlier ({hiddenCount} more)
        </button>
      ) : null}
      {visibleMessages.map((message, index) => {
        const absoluteIndex = visibleStart + index;
        return (
          <MessageItem
            key={message.id}
            message={message}
            {...(renderToolPart ? { renderToolPart } : {})}
            {...(renderText ? { renderText } : {})}
            {...(classNames?.message ? { classNames: classNames.message } : {})}
            isStreaming={
              status === 'streaming' && absoluteIndex === lastAssistantIndex
            }
          />
        );
      })}
      {showTypingBubble ? (
        <div className={classNames?.typing}>{typingIndicator ?? 'Thinking…'}</div>
      ) : null}
      {error && onRetry ? (
        <div className={classNames?.error}>
          <span>{error.message || "The assistant didn't respond."}</span>
          <button
            type="button"
            className={classNames?.errorRetry}
            onClick={() => void onRetry()}
          >
            Retry
          </button>
        </div>
      ) : null}
      {showFollowUps ? (
        <div className={classNames?.followUps}>
          {followUps.map((text) => (
            <button
              key={text}
              type="button"
              className={classNames?.followUpChip}
              onClick={() => onFollowUpClick(text)}
            >
              {text}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
