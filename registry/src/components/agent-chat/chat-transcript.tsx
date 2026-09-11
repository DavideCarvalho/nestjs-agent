'use client';

import { cn } from '@/lib/utils';
import type { ChatTranscript, TranscriptSource } from '@dudousxd/nestjs-agent-react';
import type { ReactNode } from 'react';
import { ChatFollowUps } from './chat-follow-ups';
import { ChatMessage } from './chat-message';
import type { RenderToolPartFn } from './chat-tool-group';
import { ArrowDownIcon } from './icons';

export interface ChatTranscriptProps {
  /** The whole model. Every branch below is one of its booleans. */
  transcript: ChatTranscript;
  renderText?: (text: string, ctx: { isStreaming: boolean }) => ReactNode;
  reasoningLabel?: ReactNode;
  renderSourceIcon?: (source: TranscriptSource) => ReactNode;
  onSourceClick?: (source: TranscriptSource) => void;
  sourceChips?: boolean;
  /** Draw a tool call yourself — it arrives with whatever human decision it is parked on. */
  renderToolPart?: RenderToolPartFn;
  /** The same array handed to `useChatTranscript`; whether to show it is `showFollowUps`. */
  followUps?: string[];
  onFollowUpSelect?: (text: string) => void;
  emptyState?: ReactNode;
  typingIndicator?: ReactNode;
  className?: string;
}

/** The scrolling transcript: windowed messages, a typing line, follow-ups, and a jump-to-latest. */
export function ChatTranscriptView({
  transcript,
  renderText,
  reasoningLabel,
  renderSourceIcon,
  onSourceClick,
  sourceChips = false,
  renderToolPart,
  followUps,
  onFollowUpSelect,
  emptyState,
  typingIndicator = 'Thinking…',
  className,
}: ChatTranscriptProps) {
  if (transcript.showEmptyState && emptyState) {
    return <>{emptyState}</>;
  }

  const messageSlots = {
    renderText,
    reasoningLabel,
    renderSourceIcon,
    onSourceClick,
    sourceChips,
    renderToolPart,
  };

  return (
    <div
      data-slot="chat-transcript"
      className={cn('relative flex min-h-0 flex-1 flex-col', className)}
    >
      <div
        {...transcript.scroll.getContainerProps()}
        data-slot="chat-transcript-scroller"
        className="flex-1 overflow-y-auto scroll-smooth px-4 py-4"
      >
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
          {transcript.window.canLoadEarlier ? (
            <button
              type="button"
              onClick={transcript.window.loadEarlier}
              className={cn(
                'mx-auto rounded-full border border-border bg-background px-3 py-1.5',
                'text-xs text-muted-foreground transition-colors outline-none hover:bg-accent',
                'focus-visible:ring-[3px] focus-visible:ring-ring/50',
              )}
            >
              Load {transcript.window.hiddenCount} earlier
            </button>
          ) : null}

          {transcript.items.map((item) => (
            <ChatMessage key={item.id} item={item} {...messageSlots} />
          ))}

          {transcript.showTypingIndicator ? (
            <p className="text-sm text-muted-foreground" aria-live="polite">
              {typingIndicator}
            </p>
          ) : null}

          {transcript.showFollowUps && followUps && onFollowUpSelect ? (
            <ChatFollowUps items={followUps} onSelect={onFollowUpSelect} />
          ) : null}
        </div>
      </div>

      {transcript.scroll.showJumpToLatest ? (
        <button
          type="button"
          onClick={transcript.scroll.scrollToBottom}
          aria-label="Jump to latest"
          className={cn(
            'absolute bottom-4 left-1/2 flex size-9 -translate-x-1/2 items-center justify-center',
            'rounded-full border border-border bg-background text-foreground shadow-md',
            'transition-colors outline-none hover:bg-accent',
            'focus-visible:ring-[3px] focus-visible:ring-ring/50',
          )}
        >
          <ArrowDownIcon className="size-4" />
        </button>
      ) : null}
    </div>
  );
}
