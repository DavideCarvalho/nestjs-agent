'use client';

import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';
import { PlusIcon } from './icons';

/** One named thing the next turn can read. What it stands for is the host's business. */
export interface ChatContextSource {
  id: string;
  label: string;
  icon?: ReactNode;
}

export interface ChatContextStripProps {
  sources: ChatContextSource[];
  /**
   * How many sources exist in total, when more are connected than are in scope. Omitted means the
   * listed ones are all of them.
   */
  total?: number;
  /** Overrides the "Reading 4 of 9 sources" line; `shown` is `sources.length`. */
  renderSummary?: (shown: number, total: number) => ReactNode;
  onAdd?: () => void;
  addLabel?: string;
  className?: string;
}

/**
 * The composer saying what is in scope BEFORE the question is asked, so the answer's reach is not a
 * surprise. Purely declarative — it lists what it is handed and reports the add press.
 */
export function ChatContextStrip({
  sources,
  total,
  renderSummary,
  onAdd,
  addLabel = 'Add a source',
  className,
}: ChatContextStripProps) {
  const shown = sources.length;
  const all = total ?? shown;

  return (
    <div
      data-slot="chat-context-strip"
      className={cn(
        'flex items-center justify-between gap-3 border-t border-border px-3 py-2',
        className,
      )}
    >
      <p className="min-w-0 truncate text-sm text-muted-foreground">
        {renderSummary
          ? renderSummary(shown, all)
          : `Reading ${shown} of ${all} ${all === 1 ? 'source' : 'sources'}`}
      </p>
      <div className="flex shrink-0 items-center gap-1.5">
        <ul className="flex items-center gap-1.5">
          {sources.map((source) => (
            <li key={source.id}>
              <span
                title={source.label}
                className="flex size-7 items-center justify-center rounded-md text-muted-foreground [&_svg]:size-4"
              >
                {source.icon ?? (
                  <span className="text-xs font-semibold uppercase">
                    {source.label.slice(0, 1)}
                  </span>
                )}
                <span className="sr-only">{source.label}</span>
              </span>
            </li>
          ))}
        </ul>
        {onAdd ? (
          <button
            type="button"
            onClick={onAdd}
            aria-label={addLabel}
            title={addLabel}
            className={cn(
              'flex size-7 items-center justify-center rounded-full border border-border text-muted-foreground',
              'transition-colors outline-none hover:bg-accent hover:text-foreground',
              'focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:border-ring',
            )}
          >
            <PlusIcon className="size-3.5" />
          </button>
        ) : null}
      </div>
    </div>
  );
}
