'use client';

import { cn } from '@/lib/utils';
import type { QueuePause, TranscriptQueuedItem } from '@dudousxd/nestjs-agent-react';

export interface ChatQueueProps {
  /** `transcript.queued` — messages sent mid-turn, waiting for the running turn to settle. */
  items: TranscriptQueuedItem[];
  /** `transcript.queuePaused` — why nothing starts, or `null`. */
  paused: QueuePause | null;
  /** `chat.queue.resume`. Without it a paused queue shows no resume control. */
  onResume?: () => void | Promise<void>;
  className?: string;
}

const PAUSE_REASONS: Record<QueuePause['reason'], string> = {
  run_failed: 'Paused — the last answer failed',
  cancelled: 'Paused — you stopped the answer',
  quota_exceeded: 'Paused — the budget is used up',
  start_failed: 'Paused — the next message could not start',
};

/** Waiting messages as dimmed user bubbles under the transcript, each removable. */
export function ChatQueue({ items, paused, onResume, className }: ChatQueueProps) {
  if (items.length === 0) {
    return null;
  }
  return (
    <div data-slot="chat-queue" className={cn('flex flex-col items-end gap-2', className)}>
      {items.map((item) => (
        <div
          key={item.id}
          data-state={item.state}
          className={cn(
            'group/queued flex max-w-[80%] items-start gap-2 rounded-2xl border border-dashed',
            'border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground',
          )}
        >
          <span className="min-w-0 whitespace-pre-wrap break-words">{item.text}</span>
          {item.remove.available ? (
            <button
              type="button"
              onClick={item.remove.run}
              aria-label="Remove from queue"
              className={cn(
                'shrink-0 rounded-md px-1.5 text-xs text-muted-foreground outline-none',
                'hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50',
              )}
            >
              Remove
            </button>
          ) : null}
        </div>
      ))}
      {paused !== null ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>{PAUSE_REASONS[paused.reason]}</span>
          {onResume ? (
            <button
              type="button"
              onClick={() => void onResume()}
              className={cn(
                'rounded-md border border-border px-2 py-1 text-foreground outline-none',
                'hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50',
              )}
            >
              Resume
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
