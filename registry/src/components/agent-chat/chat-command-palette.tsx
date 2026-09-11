'use client';

import { cn } from '@/lib/utils';
import { type KeyboardEvent, type ReactNode, useState } from 'react';
import { EnterIcon, XIcon } from './icons';

export interface ChatSuggestion {
  id: string;
  label: string;
  icon?: ReactNode;
}

export interface ChatCommandPaletteProps {
  suggestions: ChatSuggestion[];
  onSelect: (suggestion: ChatSuggestion) => void;
  onClose?: () => void;
  /**
   * Drive the highlight from elsewhere — the composer's textarea, so ↑/↓ work without leaving the
   * box. Omit both to let the palette own it, in which case the keys work once focus is inside.
   */
  activeIndex?: number;
  onActiveIndexChange?: (index: number) => void;
  className?: string;
}

/** Suggestions above the composer, with the keys that drive them spelled out. */
export function ChatCommandPalette({
  suggestions,
  onSelect,
  onClose,
  activeIndex,
  onActiveIndexChange,
  className,
}: ChatCommandPaletteProps) {
  const [internalIndex, setInternalIndex] = useState(0);
  const active = activeIndex ?? internalIndex;

  function moveTo(index: number) {
    const wrapped = (index + suggestions.length) % suggestions.length;
    if (activeIndex === undefined) {
      setInternalIndex(wrapped);
    }
    onActiveIndexChange?.(wrapped);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (suggestions.length === 0) {
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveTo(active + 1);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveTo(active - 1);
      return;
    }
    if (event.key === 'Enter') {
      const suggestion = suggestions[active];
      if (suggestion) {
        event.preventDefault();
        onSelect(suggestion);
      }
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose?.();
    }
  }

  if (suggestions.length === 0) {
    return null;
  }

  return (
    <div
      onKeyDown={handleKeyDown}
      className={cn('border-b border-border px-2 pt-2 pb-1', className)}
    >
      <div className="flex items-center gap-2 px-1 pb-2 text-xs text-muted-foreground">
        <KeyHint keys={['↑', '↓']} action="navigate" />
        <KeyHint keys={['Enter']} action="select" />
        <span className="ml-auto flex items-center gap-1.5">
          <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-sans text-[0.6875rem] leading-none">
            Esc
          </kbd>
          {onClose ? (
            <button
              type="button"
              onClick={onClose}
              aria-label="Dismiss suggestions"
              className={cn(
                'flex size-5 items-center justify-center rounded transition-colors outline-none',
                'hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50',
              )}
            >
              <XIcon className="size-3.5" />
            </button>
          ) : null}
        </span>
      </div>
      <ul aria-label="Suggestions" className="flex flex-col">
        {suggestions.map((suggestion, index) => (
          <li key={suggestion.id}>
            <button
              type="button"
              onClick={() => onSelect(suggestion)}
              onMouseEnter={() => moveTo(index)}
              aria-current={index === active}
              className={cn(
                'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm',
                'transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                index === active
                  ? 'bg-accent text-accent-foreground'
                  : 'text-muted-foreground hover:bg-accent/50',
              )}
            >
              <span className="shrink-0 [&_svg]:size-3.5">
                {suggestion.icon ?? <EnterIcon className="size-3.5" />}
              </span>
              <span className="min-w-0 truncate">{suggestion.label}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function KeyHint({ keys, action }: { keys: string[]; action: string }) {
  return (
    <span className="flex items-center gap-1">
      {keys.map((key) => (
        <kbd
          key={key}
          className="rounded border border-border bg-muted px-1.5 py-0.5 font-sans text-[0.6875rem] leading-none"
        >
          {key}
        </kbd>
      ))}
      {action}
    </span>
  );
}
