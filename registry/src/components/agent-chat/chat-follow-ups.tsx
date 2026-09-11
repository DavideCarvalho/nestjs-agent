'use client';

import { cn } from '@/lib/utils';
import { EnterIcon } from './icons';

export interface ChatFollowUpsProps {
  /** Suggested next questions. Whether they belong on screen is `transcript.showFollowUps`. */
  items: string[];
  onSelect: (text: string) => void;
  className?: string;
}

/** Follow-ups as right-aligned pills, sitting where the user's next message would. */
export function ChatFollowUps({ items, onSelect, className }: ChatFollowUpsProps) {
  if (items.length === 0) {
    return null;
  }
  return (
    <ul
      aria-label="Suggested follow-ups"
      className={cn('flex flex-col items-end gap-2', className)}
    >
      {items.map((text) => (
        <li key={text}>
          <button
            type="button"
            onClick={() => onSelect(text)}
            className={cn(
              'inline-flex max-w-full items-center gap-2 rounded-xl border border-border',
              'bg-background px-3 py-2 text-left text-sm text-foreground',
              'transition-colors outline-none hover:bg-accent',
              'focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:border-ring',
            )}
          >
            <span className="min-w-0 truncate">{text}</span>
            <EnterIcon className="size-3.5 shrink-0 text-muted-foreground" />
          </button>
        </li>
      ))}
    </ul>
  );
}
