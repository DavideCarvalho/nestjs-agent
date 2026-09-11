'use client';

import { cn } from '@/lib/utils';
import {
  type AutocompleteSource,
  type ComposerAutocomplete,
  type TranscriptStopState,
  useComposerAutocomplete,
} from '@dudousxd/nestjs-agent-react';
import { type ChangeEvent, type KeyboardEvent, type ReactNode, useState } from 'react';
import { ChatCommandPalette } from './chat-command-palette';
import { ArrowUpIcon, PaperclipIcon, StopIcon } from './icons';

/** Stable identity so the autocomplete's request effect doesn't re-fire on every render. */
const NO_SOURCES: readonly AutocompleteSource[] = [];

/**
 * Why the menu is empty. A source that offered nothing at all and a query that matched nothing are
 * different facts — "no skills are configured for you" reads as a bug when it says "no matches".
 */
function emptyMenuStatus(autocomplete: ComposerAutocomplete): string {
  if (autocomplete.isLoading) {
    return 'Searching…';
  }
  return autocomplete.query.length > 0 ? 'No matches' : 'Nothing to complete';
}

export interface ChatComposerProps {
  onSubmit: (text: string) => void;
  /**
   * `transcript.stop` from `useChatTranscript`. While it is `available` the submit control becomes
   * the cancel control — one button, because at any moment exactly one of the two is meaningful.
   */
  stop?: TranscriptStopState;
  /** Controlled draft. Omit both to let the composer hold its own. */
  value?: string;
  onValueChange?: (value: string) => void;
  defaultValue?: string;
  placeholder?: string;
  disabled?: boolean;
  onAttach?: () => void;
  attachLabel?: string;
  /** Sits left of the submit control — a model or mode selector, say. */
  trailing?: ReactNode;
  /** Rendered inside the card, below the divider — e.g. `<ChatContextStrip />`. */
  footer?: ReactNode;
  /** Rendered above the card inside the same rounded shell — e.g. a suggestion palette. */
  overlay?: ReactNode;
  /**
   * Triggers the draft completes against — `/` for commands, `@` for a mention. The composer knows
   * nothing about what a source offers; while one is open it takes over ↑ ↓ Enter Tab Esc, and
   * Enter stops sending. Omitted, the composer behaves exactly as it did without them.
   */
  autocompleteSources?: readonly AutocompleteSource[];
  onAutocompleteError?: (error: unknown, source: AutocompleteSource) => void;
  submitLabel?: string;
  /** The key that sends, shown as a hint beside submit. `null` hides the hint. */
  submitHint?: string | null;
  className?: string;
}

/**
 * The composer as a card: a growing textarea, an attach affordance, a slot for a selector, and one
 * circular control that submits or cancels. Enter sends, Shift+Enter breaks the line.
 */
export function ChatComposer({
  onSubmit,
  stop,
  value,
  onValueChange,
  defaultValue = '',
  placeholder = 'Ask anything',
  disabled = false,
  onAttach,
  attachLabel = 'Attach a file',
  trailing,
  footer,
  overlay,
  autocompleteSources,
  onAutocompleteError,
  submitLabel = 'Send',
  submitHint = 'Enter',
  className,
}: ChatComposerProps) {
  const [internal, setInternal] = useState(defaultValue);
  const draft = value ?? internal;
  const isBusy = stop?.available === true;

  function setDraft(next: string) {
    if (value === undefined) {
      setInternal(next);
    }
    onValueChange?.(next);
  }

  const autocomplete = useComposerAutocomplete({
    value: draft,
    onValueChange: setDraft,
    sources: autocompleteSources ?? NO_SOURCES,
    ...(onAutocompleteError !== undefined ? { onError: onAutocompleteError } : {}),
  });
  const inputProps = autocomplete.getInputProps();

  function submit() {
    const trimmed = draft.trim();
    if (!trimmed || disabled || isBusy) {
      return;
    }
    onSubmit(trimmed);
    setDraft('');
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // The open menu gets first refusal: it marks the keys it consumed as handled, and Enter picking
    // a command must never also send the half-typed line.
    inputProps.onKeyDown(event);
    if (event.defaultPrevented) {
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  }

  function handleChange(event: ChangeEvent<HTMLTextAreaElement>) {
    setDraft(event.target.value);
    inputProps.onChange(event);
  }

  return (
    <div
      data-slot="chat-composer"
      className={cn(
        'group/composer rounded-2xl border border-border bg-card text-card-foreground shadow-sm',
        'focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/40',
        'transition-[color,box-shadow]',
        className,
      )}
    >
      {autocomplete.isOpen ? (
        <ChatCommandPalette
          suggestions={autocomplete.items.map((item) => ({
            id: item.id,
            label: item.label,
            ...(item.description !== undefined ? { description: item.description } : {}),
            ...(item.hint !== undefined ? { hint: item.hint } : {}),
          }))}
          onSelect={(suggestion) => {
            const picked = autocomplete.items.find((item) => item.id === suggestion.id);
            if (picked) {
              autocomplete.accept(picked);
            }
          }}
          onClose={autocomplete.dismiss}
          activeIndex={autocomplete.activeIndex}
          onActiveIndexChange={autocomplete.highlight}
          listboxProps={autocomplete.getListboxProps()}
          getOptionProps={autocomplete.getOptionProps}
          status={autocomplete.error ?? emptyMenuStatus(autocomplete)}
        />
      ) : (
        overlay
      )}
      <div className="px-3 pt-3">
        <textarea
          {...inputProps}
          rows={2}
          value={draft}
          disabled={disabled}
          placeholder={placeholder}
          aria-label={placeholder}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          // `field-sizing-content` grows the box with the text and needs no measuring pass; the
          // max height keeps a pasted essay from swallowing the transcript.
          className={cn(
            'field-sizing-content max-h-56 w-full resize-none bg-transparent text-base',
            'text-foreground placeholder:text-muted-foreground outline-none',
            'disabled:cursor-not-allowed disabled:opacity-60',
          )}
        />
      </div>

      <div className="flex items-center gap-2 px-3 pb-3 pt-2">
        {onAttach ? (
          <button
            type="button"
            onClick={onAttach}
            disabled={disabled}
            aria-label={attachLabel}
            title={attachLabel}
            className={cn(
              'flex size-8 items-center justify-center rounded-lg text-muted-foreground',
              'transition-colors outline-none hover:bg-accent hover:text-foreground',
              'focus-visible:ring-[3px] focus-visible:ring-ring/50',
              'disabled:pointer-events-none disabled:opacity-50',
            )}
          >
            <PaperclipIcon className="size-4.5" />
          </button>
        ) : null}

        <div className="ml-auto flex items-center gap-2">
          {trailing}
          {submitHint !== null && !isBusy ? (
            <span className="hidden items-center gap-1.5 text-xs text-muted-foreground group-focus-within/composer:flex">
              {submitLabel}
              <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-sans text-[0.6875rem] leading-none">
                {submitHint}
              </kbd>
            </span>
          ) : null}
          {isBusy && stop ? (
            <button
              type="button"
              onClick={stop.stop}
              disabled={stop.isStopping}
              aria-label={stop.isStopping ? 'Stopping' : 'Stop generating'}
              title={stop.isStopping ? 'Stopping…' : 'Stop generating'}
              className={cn(
                'flex size-9 items-center justify-center rounded-full',
                'bg-foreground text-background transition-opacity outline-none',
                'hover:opacity-90 focus-visible:ring-[3px] focus-visible:ring-ring/50',
                'disabled:opacity-60',
              )}
            >
              <StopIcon className="size-4" />
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={disabled || draft.trim().length === 0}
              aria-label={submitLabel}
              title={submitLabel}
              className={cn(
                'flex size-9 items-center justify-center rounded-full',
                'bg-foreground text-background transition-opacity outline-none',
                'hover:opacity-90 focus-visible:ring-[3px] focus-visible:ring-ring/50',
                'disabled:pointer-events-none disabled:opacity-40',
              )}
            >
              <ArrowUpIcon className="size-4.5" />
            </button>
          )}
        </div>
      </div>

      {footer}
    </div>
  );
}
