'use client';

import { cn } from '@/lib/utils';
import type {
  TranscriptBlock,
  TranscriptItem,
  TranscriptSource,
  TranscriptSourcesBlock,
} from '@dudousxd/nestjs-agent-react';
import type { ReactNode } from 'react';
import { ChatElicitation } from './chat-elicitation';
import { ChatReasoning } from './chat-reasoning';
import { ChatSourceChips, ChatSources } from './chat-sources';
import { ChatToolGroup, type RenderToolPartFn } from './chat-tool-group';
import { BranchIcon, CheckIcon, CopyIcon, PencilIcon, RefreshIcon } from './icons';

type BodyBlock = Exclude<TranscriptBlock, TranscriptSourcesBlock>;

function isSourcesBlock(block: TranscriptBlock): block is TranscriptSourcesBlock {
  return block.kind === 'sources';
}

export interface ChatMessageProps {
  /** One item off `transcript.items` — every value and every action below comes from it. */
  item: TranscriptItem;
  /** Render the prose. Pass a markdown renderer here; plain text is the default. */
  renderText?: (text: string, ctx: { isStreaming: boolean }) => ReactNode;
  reasoningLabel?: ReactNode;
  /** A duration for a reasoning segment, when the host has one — the model carries no timing. */
  reasoningDuration?: ReactNode;
  renderSourceIcon?: (source: TranscriptSource) => ReactNode;
  onSourceClick?: (source: TranscriptSource) => void;
  /** Repeat the origins as chips under the answer body. */
  sourceChips?: boolean;
  /** Draw a tool call yourself — a rendered result, a diff, a map. Falls back to the tool card. */
  renderToolPart?: RenderToolPartFn;
  className?: string;
}

export function ChatMessage({
  item,
  renderText,
  reasoningLabel,
  reasoningDuration,
  renderSourceIcon,
  onSourceClick,
  sourceChips = false,
  renderToolPart,
  className,
}: ChatMessageProps) {
  if (item.edit.isEditing) {
    return <EditingBubble item={item} className={className} />;
  }

  // Provenance reads as a preamble to the answer rather than a footnote inside it, so the sources
  // blocks are hoisted above the body wherever the retrieval part happens to sit in the message.
  const sources = item.blocks.filter(isSourcesBlock);
  const body = item.blocks.filter((block): block is BodyBlock => block.kind !== 'sources');

  return (
    <article
      data-role={item.role}
      data-streaming={item.isStreaming ? 'true' : undefined}
      className={cn('group/message flex flex-col gap-2', item.isUser && 'items-end', className)}
    >
      {sources.map((block) => (
        <ChatSources
          key={block.key}
          block={block}
          className="w-full"
          renderSourceIcon={renderSourceIcon}
          onSourceClick={onSourceClick}
        />
      ))}

      <div
        className={cn(
          'flex max-w-full flex-col gap-2.5',
          item.isUser
            ? 'rounded-2xl rounded-br-md bg-muted px-4 py-2.5 text-foreground'
            : 'w-full rounded-2xl border border-border bg-card px-4 py-3 text-card-foreground',
        )}
      >
        {body.map((block) => {
          if (block.kind === 'text') {
            return (
              <div
                key={block.key}
                className="text-sm leading-relaxed whitespace-pre-wrap text-pretty"
              >
                {renderText
                  ? renderText(block.text, { isStreaming: block.isStreaming })
                  : block.text}
              </div>
            );
          }
          if (block.kind === 'reasoning') {
            return (
              <ChatReasoning
                key={block.key}
                block={block}
                label={reasoningLabel}
                duration={reasoningDuration}
              />
            );
          }
          if (block.kind === 'elicitation') {
            return <ChatElicitation key={block.key} block={block} />;
          }
          return <ChatToolGroup key={block.key} block={block} renderToolPart={renderToolPart} />;
        })}

        {sourceChips
          ? sources.map((block) => (
              <ChatSourceChips
                key={`${block.key}-chips`}
                block={block}
                onSourceClick={onSourceClick}
              />
            ))
          : null}
      </div>

      <MessageActions item={item} />
    </article>
  );
}

function MessageActions({ item }: { item: TranscriptItem }) {
  const hasAction =
    item.copy.available || item.edit.available || item.fork.available || item.regenerate.available;
  if (!hasAction && !item.usage && !item.timestamp) {
    return null;
  }

  return (
    <div
      data-actions-for={item.role}
      className={cn(
        'flex items-center gap-0.5 text-muted-foreground',
        // The row stays reachable by keyboard while it is visually quiet.
        'opacity-0 transition-opacity focus-within:opacity-100 group-hover/message:opacity-100',
      )}
    >
      {item.copy.available ? (
        <ActionButton
          onClick={item.copy.copy}
          label={item.copy.copied ? 'Copied' : 'Copy message'}
          icon={item.copy.copied ? <CheckIcon /> : <CopyIcon />}
        />
      ) : null}
      {item.edit.available ? (
        <ActionButton onClick={item.edit.start} label="Edit and resend" icon={<PencilIcon />} />
      ) : null}
      {item.fork.available ? (
        <ActionButton onClick={item.fork.run} label="Fork from here" icon={<BranchIcon />} />
      ) : null}
      {item.regenerate.available ? (
        <ActionButton onClick={item.regenerate.run} label="Regenerate" icon={<RefreshIcon />} />
      ) : null}
      {item.usage ? (
        <span
          className="ml-1 text-xs tabular-nums"
          title={`Input ${item.usage.inputTokens.toLocaleString()} · output ${item.usage.outputTokens.toLocaleString()} tokens`}
        >
          {item.usage.costLabel} · {item.usage.tokensLabel}
        </span>
      ) : null}
      {item.timestamp ? (
        <time
          dateTime={item.timestamp.iso}
          title={item.timestamp.absolute}
          className="ml-1 text-xs"
        >
          {item.timestamp.relative}
        </time>
      ) : null}
    </div>
  );
}

interface ActionButtonProps {
  onClick: () => void;
  label: string;
  icon: ReactNode;
}

function ActionButton({ onClick, label, icon }: ActionButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(
        'flex size-7 items-center justify-center rounded-md [&_svg]:size-3.5',
        'transition-colors outline-none hover:bg-accent hover:text-foreground',
        'focus-visible:ring-[3px] focus-visible:ring-ring/50',
      )}
    >
      {icon}
    </button>
  );
}

function EditingBubble({ item, className }: { item: TranscriptItem; className?: string }) {
  const textareaProps = item.edit.getTextareaProps();
  return (
    <div data-editing="true" className={cn('flex flex-col items-end gap-2', className)}>
      <textarea
        {...textareaProps}
        aria-label="Edit message"
        rows={Math.min(8, item.edit.draft.split('\n').length + 1)}
        className={cn(
          'w-full resize-none rounded-2xl border border-border bg-card px-4 py-2.5',
          'text-sm text-foreground outline-none',
          'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40',
        )}
      />
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={item.edit.cancel}
          className={cn(
            'rounded-lg px-3 py-1.5 text-sm text-muted-foreground',
            'transition-colors outline-none hover:bg-accent hover:text-foreground',
            'focus-visible:ring-[3px] focus-visible:ring-ring/50',
          )}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={item.edit.save}
          disabled={!item.edit.canSave}
          className={cn(
            'rounded-lg bg-foreground px-3 py-1.5 text-sm text-background',
            'transition-opacity outline-none hover:opacity-90',
            'focus-visible:ring-[3px] focus-visible:ring-ring/50',
            'disabled:pointer-events-none disabled:opacity-40',
          )}
        >
          Resend
        </button>
      </div>
    </div>
  );
}
