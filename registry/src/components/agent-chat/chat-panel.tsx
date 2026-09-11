'use client';

import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';
import { PlusIcon, XIcon } from './icons';

export interface ChatPanelProps {
  /** The thread's title. */
  title: ReactNode;
  /** A mark left of the title — a product glyph, an agent avatar. */
  mark?: ReactNode;
  /** Between the title and the actions — a model or agent picker. */
  toolbar?: ReactNode;
  onNewThread?: () => void;
  onClose?: () => void;
  children: ReactNode;
  /** Pinned under the scrolling body — the composer. */
  footer?: ReactNode;
  className?: string;
}

/** A docked chat surface: fixed header, scrolling body, pinned composer. */
export function ChatPanel({
  title,
  mark,
  toolbar,
  onNewThread,
  onClose,
  children,
  footer,
  className,
}: ChatPanelProps) {
  return (
    <section
      className={cn(
        'flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-border',
        'bg-background text-foreground shadow-lg',
        className,
      )}
    >
      <header className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        {mark ? <span className="shrink-0 [&_svg]:size-4">{mark}</span> : null}
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{title}</h2>
        {toolbar}
        {onNewThread ? (
          <HeaderButton onClick={onNewThread} label="New thread">
            <PlusIcon className="size-4" />
          </HeaderButton>
        ) : null}
        {onClose ? (
          <HeaderButton onClick={onClose} label="Close chat">
            <XIcon className="size-4" />
          </HeaderButton>
        ) : null}
      </header>

      <div className="flex min-h-0 flex-1 flex-col">{children}</div>

      {footer ? <div className="border-t border-border p-3">{footer}</div> : null}
    </section>
  );
}

function HeaderButton({
  onClick,
  label,
  children,
}: {
  onClick: () => void;
  label: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(
        'flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground',
        'transition-colors outline-none hover:bg-accent hover:text-foreground',
        'focus-visible:ring-[3px] focus-visible:ring-ring/50',
      )}
    >
      {children}
    </button>
  );
}
