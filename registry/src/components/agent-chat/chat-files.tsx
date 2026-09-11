'use client';

import { cn } from '@/lib/utils';
import type { TranscriptFilesBlock } from '@dudousxd/nestjs-agent-react';
import { PaperclipIcon } from './icons';

export interface ChatFilesProps {
  /** A `files` block off `item.blocks` — everything attached at one point in the turn. */
  block: TranscriptFilesBlock;
  className?: string;
}

/**
 * What was attached, as the thing itself. An image is shown at a size that reads without taking the
 * turn over; anything else is a chip that names it and opens it, because a format this surface
 * cannot display is more useful pointed at than guessed at.
 */
export function ChatFiles({ block, className }: ChatFilesProps) {
  return (
    <div data-slot="chat-files" className={cn('flex flex-wrap items-start gap-2', className)}>
      {block.files.map((file) => {
        const label = file.filename ?? (file.isImage ? 'image' : file.mediaType);
        if (file.isImage) {
          return (
            <a key={file.url} href={file.url} target="_blank" rel="noreferrer">
              <img
                src={file.url}
                alt={label}
                className="max-h-64 max-w-full rounded-xl border border-border object-contain"
              />
            </a>
          );
        }
        return (
          <a
            key={file.url}
            href={file.url}
            target="_blank"
            rel="noreferrer"
            title={label}
            className={cn(
              'inline-flex max-w-56 items-center gap-2 rounded-lg border border-border bg-card px-3 py-2',
              'text-xs text-foreground transition-colors outline-none hover:bg-accent',
              'focus-visible:ring-[3px] focus-visible:ring-ring/50',
            )}
          >
            <PaperclipIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{label}</span>
          </a>
        );
      })}
    </div>
  );
}
