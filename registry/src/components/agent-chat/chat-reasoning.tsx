'use client';

import { cn } from '@/lib/utils';
import type { TranscriptReasoningBlock } from '@dudousxd/nestjs-agent-react';
import type { ReactNode } from 'react';
import { ChevronDownIcon, ClockIcon } from './icons';

export interface ChatReasoningProps {
  /** A `reasoning` block off `item.blocks`. Its open state and toggle belong to the model. */
  block: TranscriptReasoningBlock;
  label?: ReactNode;
  /**
   * How long the thinking took. The transcript model carries no timing — neither the stream nor the
   * persisted message records one — so a host that has a duration passes it; otherwise none shows.
   */
  duration?: ReactNode;
  children?: ReactNode;
  className?: string;
}

/** A named, collapsible segment of the answer. Open while it streams, folded once the answer lands. */
export function ChatReasoning({
  block,
  label = 'Reasoning',
  duration,
  children,
  className,
}: ChatReasoningProps) {
  const regionId = `${block.key}-body`;

  return (
    <div
      data-slot="chat-reasoning"
      className={cn('rounded-xl border border-border/70 bg-muted/30', className)}
    >
      <button
        type="button"
        onClick={() => block.toggle()}
        aria-expanded={block.isOpen}
        aria-controls={regionId}
        className={cn(
          'flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left',
          'transition-colors outline-none hover:bg-accent/50',
          'focus-visible:ring-[3px] focus-visible:ring-ring/50',
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            'size-1.5 shrink-0 rounded-full bg-muted-foreground',
            block.isStreaming && 'animate-pulse bg-foreground',
          )}
        />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{label}</span>
        {duration ? (
          <span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground tabular-nums">
            <ClockIcon className="size-3.5" />
            {duration}
          </span>
        ) : null}
        <ChevronDownIcon
          className={cn(
            'size-4 shrink-0 text-muted-foreground transition-transform',
            block.isOpen && 'rotate-180',
          )}
        />
      </button>
      {block.isOpen ? (
        <div
          id={regionId}
          className="px-3 pb-3 text-sm leading-relaxed whitespace-pre-wrap text-muted-foreground"
        >
          {children ?? block.text}
        </div>
      ) : null}
    </div>
  );
}
