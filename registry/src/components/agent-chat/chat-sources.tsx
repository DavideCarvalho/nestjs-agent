'use client';

import { cn } from '@/lib/utils';
import type { TranscriptSource, TranscriptSourcesBlock } from '@dudousxd/nestjs-agent-react';
import type { ReactNode } from 'react';
import { CheckIcon, DocumentIcon } from './icons';

export interface ChatSourcesProps {
  /** A `sources` block off `item.blocks` — set `sources: true` on the transcript to get them. */
  block: TranscriptSourcesBlock;
  /** A mark per origin — a product logo, an avatar. Falls back to a document glyph. */
  renderSourceIcon?: (source: TranscriptSource) => ReactNode;
  /** Overrides the "Answered from 3 sources" line. */
  renderSummary?: (block: TranscriptSourcesBlock) => ReactNode;
  onSourceClick?: (source: TranscriptSource) => void;
  className?: string;
}

/**
 * What the answer was built from, above the answer. The counts are the retriever's own: how many
 * distinct origins it drew on, and how many passages each contributed.
 */
export function ChatSources({
  block,
  renderSourceIcon,
  renderSummary,
  onSourceClick,
  className,
}: ChatSourcesProps) {
  if (block.sources.length === 0) {
    return null;
  }

  return (
    <section
      data-slot="chat-sources"
      aria-label="Sources for this answer"
      className={cn('rounded-xl border border-border bg-muted/40 p-3', className)}
    >
      <p className="px-1 pb-1 text-xs font-medium text-muted-foreground">
        {renderSummary ? renderSummary(block) : defaultSummary(block)}
      </p>
      <ul className="flex flex-col">
        {block.sources.map((source) => {
          const line = (
            <>
              <CheckIcon className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
              <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                {source.label}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                {source.passageCount === 1 ? '1 passage' : `${source.passageCount} passages`}
              </span>
              <span className="shrink-0 text-muted-foreground [&_svg]:size-4">
                {renderSourceIcon ? renderSourceIcon(source) : <DocumentIcon className="size-4" />}
              </span>
            </>
          );
          return (
            <li key={source.id}>
              {onSourceClick ? (
                <button
                  type="button"
                  onClick={() => onSourceClick(source)}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-lg px-1 py-1.5 text-left',
                    'transition-colors outline-none hover:bg-accent/60',
                    'focus-visible:ring-[3px] focus-visible:ring-ring/50',
                  )}
                >
                  {line}
                </button>
              ) : (
                <div className="flex items-center gap-2.5 px-1 py-1.5">{line}</div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export interface ChatSourceChipsProps {
  block: TranscriptSourcesBlock;
  onSourceClick?: (source: TranscriptSource) => void;
  className?: string;
}

/** The same provenance, compact, for under the answer body. */
export function ChatSourceChips({ block, onSourceClick, className }: ChatSourceChipsProps) {
  if (block.sources.length === 0) {
    return null;
  }
  return (
    <ul aria-label="Sources" className={cn('flex flex-wrap gap-1.5', className)}>
      {block.sources.map((source) => (
        <li key={source.id}>
          <button
            type="button"
            disabled={onSourceClick === undefined}
            onClick={() => onSourceClick?.(source)}
            title={source.label}
            className={cn(
              'inline-flex max-w-56 items-center gap-1.5 rounded-md border border-border',
              'bg-background px-2 py-1 text-xs text-muted-foreground',
              'transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
              onSourceClick ? 'hover:bg-accent hover:text-foreground' : 'cursor-default',
            )}
          >
            <DocumentIcon className="size-3.5 shrink-0" />
            <span className="truncate">{source.label}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function defaultSummary(block: TranscriptSourcesBlock): string {
  const count = block.sources.length;
  return `Answered from ${count} ${count === 1 ? 'source' : 'sources'}`;
}
