'use client';

import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';

/**
 * A way of running the turn, not a canned prompt: picking one changes which agent, tools or output
 * shape the next message uses, so the pill stays selected after sending rather than filling the box.
 */
export interface ChatMode {
  id: string;
  label: string;
  icon?: ReactNode;
  /** Accessible detail — what choosing this mode changes. */
  description?: string;
  disabled?: boolean;
}

export interface ChatModePillsProps {
  modes: ChatMode[];
  /** The selected mode's id. `null` for "no mode", which is a legitimate state. */
  value?: string | null;
  onSelect?: (mode: ChatMode) => void;
  /** Names the group for screen readers. */
  label?: string;
  className?: string;
}

export function ChatModePills({
  modes,
  value = null,
  onSelect,
  label = 'Response mode',
  className,
}: ChatModePillsProps) {
  return (
    <fieldset
      aria-label={label}
      data-slot="chat-mode-pills"
      className={cn('flex flex-wrap justify-center gap-2', className)}
    >
      {modes.map((mode) => {
        const isSelected = mode.id === value;
        return (
          <button
            key={mode.id}
            type="button"
            aria-pressed={isSelected}
            disabled={mode.disabled === true}
            title={mode.description}
            onClick={() => onSelect?.(mode)}
            className={cn(
              'inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-medium',
              'transition-colors outline-none',
              'focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:border-ring',
              'disabled:pointer-events-none disabled:opacity-50',
              isSelected
                ? 'border-foreground/20 bg-accent text-accent-foreground shadow-xs'
                : 'border-border bg-background text-muted-foreground hover:bg-accent/50 hover:text-foreground',
            )}
          >
            {mode.icon ? <span className="[&_svg]:size-4 shrink-0">{mode.icon}</span> : null}
            {mode.label}
          </button>
        );
      })}
    </fieldset>
  );
}
