import type { UIMessage } from 'ai';
import type React from 'react';
import type { ChatStatus, MessageUsageInfo } from '../transcript/model.js';
import { useChatTranscript } from '../transcript/use-chat-transcript.js';
import {
  type MessageItemClassNames,
  MessageItemView,
  type RenderFilesFn,
  type RenderReasoningFn,
  type RenderTextFn,
  type RenderToolGroupFn,
  type RenderToolPartFn,
} from './message-item.js';

export type { ChatStatus } from '../transcript/model.js';

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
  renderToolGroup?: RenderToolGroupFn;
  renderText?: RenderTextFn;
  /** Render the body of a reasoning run; the disclosure toggle is the list's. */
  renderReasoning?: RenderReasoningFn;
  /** Draw a message's files yourself. Omitted → images inline, everything else a link. */
  renderFiles?: RenderFilesFn;
  reasoningLabel?: React.ReactNode;
  /** Extra content for one message's action row — e.g. a badge naming which agent answered. */
  getMeta?: (message: UIMessage) => React.ReactNode;
  /** When set, every message gets a "Fork" affordance calling back with its id. */
  onFork?: (uiMessageId: string) => void | Promise<void>;
  /** User messages get an inline edit-and-resubmit affordance. */
  editable?: boolean;
  onEditSubmit?: (uiMessageId: string, newText: string) => void | Promise<void>;
  /** The last assistant message gets a "Regenerate" affordance. */
  regeneratable?: boolean;
  onRegenerate?: (uiMessageId: string) => void | Promise<void>;
  /** Per-message resolvers for the usage line and the persisted timestamp. */
  getUsage?: (message: UIMessage) => MessageUsageInfo | null;
  getCreatedAt?: (message: UIMessage) => string | null;
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
 *
 * Every decision here comes from `useChatTranscript`; the file below it is markup. A host that
 * wants a different layout drives that hook directly and never imports this component.
 */
export function MessageList({
  messages,
  status,
  renderToolPart,
  renderToolGroup,
  renderText,
  renderReasoning,
  renderFiles,
  reasoningLabel,
  getMeta,
  onFork,
  editable,
  onEditSubmit,
  regeneratable,
  onRegenerate,
  getUsage,
  getCreatedAt,
  emptyState,
  typingIndicator,
  followUps,
  onFollowUpClick,
  error,
  onRetry,
  classNames,
}: MessageListProps) {
  const transcript = useChatTranscript({
    messages,
    status,
    ...(onFork ? { onFork } : {}),
    ...(editable !== undefined ? { editable } : {}),
    ...(onEditSubmit ? { onEditSubmit } : {}),
    ...(regeneratable !== undefined ? { regeneratable } : {}),
    ...(onRegenerate ? { onRegenerate } : {}),
    ...(getUsage ? { getUsage } : {}),
    ...(getCreatedAt ? { getCreatedAt } : {}),
    ...(followUps !== undefined ? { followUps } : {}),
  });

  if (transcript.showEmptyState) {
    return <div className={classNames?.empty}>{emptyState}</div>;
  }

  const slots = {
    ...(renderToolPart ? { renderToolPart } : {}),
    ...(renderToolGroup ? { renderToolGroup } : {}),
    ...(renderText ? { renderText } : {}),
    ...(renderReasoning ? { renderReasoning } : {}),
    ...(renderFiles ? { renderFiles } : {}),
    ...(reasoningLabel !== undefined ? { reasoningLabel } : {}),
    ...(classNames?.message ? { classNames: classNames.message } : {}),
  };

  return (
    <div className={classNames?.root}>
      {transcript.window.canLoadEarlier ? (
        <button
          type="button"
          className={classNames?.loadEarlier}
          onClick={transcript.window.loadEarlier}
        >
          Load earlier ({transcript.window.hiddenCount} more)
        </button>
      ) : null}
      {transcript.items.map((item) => (
        <MessageItemView
          key={item.id}
          item={item}
          {...slots}
          {...(getMeta ? { meta: getMeta(item.message) } : {})}
        />
      ))}
      {transcript.showTypingIndicator ? (
        <div className={classNames?.typing}>{typingIndicator ?? 'Thinking…'}</div>
      ) : null}
      {error && onRetry ? (
        <div className={classNames?.error}>
          <span>{error.message || "The assistant didn't respond."}</span>
          <button type="button" className={classNames?.errorRetry} onClick={() => void onRetry()}>
            Retry
          </button>
        </div>
      ) : null}
      {transcript.showFollowUps && onFollowUpClick && followUps ? (
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
