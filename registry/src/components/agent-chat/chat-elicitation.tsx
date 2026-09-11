'use client';

import { cn } from '@/lib/utils';
import type { TranscriptElicitationBlock, TranscriptQuestion } from '@dudousxd/nestjs-agent-react';
import type { KeyboardEvent } from 'react';
import { CheckIcon } from './icons';

export interface ChatElicitationProps {
  /** An `elicitation` block off `item.blocks` — every value and both actions come from it. */
  block: TranscriptElicitationBlock;
  className?: string;
}

/**
 * The agent's questions, inline in the turn that asked them. Every option is pre-picked by the
 * agent, so the form is written to be confirmable without reading it: submit takes the picks as
 * they stand, and only the questions the user actually touched are sent.
 */
export function ChatElicitation({ block, className }: ChatElicitationProps) {
  return (
    <form
      data-slot="chat-elicitation"
      data-pending={block.isPending ? 'true' : undefined}
      aria-label="Questions from the agent"
      onSubmit={(event) => {
        event.preventDefault();
        block.answer.run();
      }}
      className={cn(
        'flex flex-col gap-3 rounded-xl border border-border bg-muted/30 p-3',
        className,
      )}
    >
      {block.preamble ? (
        <p className="text-sm leading-relaxed text-foreground text-pretty">{block.preamble}</p>
      ) : null}

      {block.questions.map((question) => (
        <Question
          key={question.id}
          question={question}
          count={block.questionCount}
          isPending={block.isPending}
        />
      ))}

      {block.error ? (
        <p role="alert" className="text-xs text-destructive">
          {block.error}
        </p>
      ) : null}

      {block.isPending ? (
        <div className="flex items-center gap-2">
          {block.answer.available ? (
            <button
              type="submit"
              disabled={block.answer.isSubmitting}
              className={cn(
                'rounded-lg bg-foreground px-3 py-1.5 text-sm text-background',
                'transition-opacity outline-none hover:opacity-90',
                'focus-visible:ring-[3px] focus-visible:ring-ring/50',
                'disabled:pointer-events-none disabled:opacity-40',
              )}
            >
              {block.answer.isSubmitting ? 'Confirming…' : 'Confirm'}
            </button>
          ) : null}
          {block.skip.available ? (
            <button
              type="button"
              onClick={block.skip.run}
              disabled={block.skip.isSubmitting}
              className={cn(
                'rounded-lg px-3 py-1.5 text-sm text-muted-foreground',
                'transition-colors outline-none hover:bg-accent hover:text-foreground',
                'focus-visible:ring-[3px] focus-visible:ring-ring/50',
                'disabled:pointer-events-none disabled:opacity-40',
              )}
            >
              Skip
            </button>
          ) : null}
        </div>
      ) : (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <CheckIcon className="size-3.5 shrink-0" />
          {block.outcome?.skipped ? 'Skipped — proceeding on the pre-picked answers' : 'Answered'}
        </p>
      )}
    </form>
  );
}

interface QuestionProps {
  question: TranscriptQuestion;
  count: number;
  isPending: boolean;
}

function Question({ question, count, isPending }: QuestionProps) {
  // Scoped to this question rather than the whole form: two questions may legitimately offer the
  // same letter, and the request is under no obligation to keep them unique across the set.
  function onKeyDown(event: KeyboardEvent<HTMLFieldSetElement>) {
    if (!isPending || event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }
    const pressed = event.key.toLowerCase();
    const hit = question.options.find((option) => option.hotkey?.toLowerCase() === pressed);
    if (hit) {
      event.preventDefault();
      hit.select();
    }
  }

  return (
    <fieldset onKeyDown={onKeyDown} className="flex flex-col gap-1">
      <legend className="flex flex-col pb-1">
        {count > 1 ? (
          <span className="text-[0.6875rem] font-medium tracking-wide text-muted-foreground uppercase">
            Question {question.position} of {count}
          </span>
        ) : null}
        <span className="text-sm font-medium text-foreground">{question.prompt}</span>
      </legend>

      {question.options.map((option) => (
        <label
          key={option.value}
          className={cn(
            'flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5',
            'transition-colors hover:bg-accent/50',
            'has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/50',
            !isPending && 'cursor-default hover:bg-transparent',
          )}
        >
          <input
            type={question.multiple ? 'checkbox' : 'radio'}
            name={`${question.id}-${question.position}`}
            checked={option.isSelected}
            disabled={!isPending}
            onChange={option.select}
            className="size-4 shrink-0 accent-foreground outline-none"
          />
          {option.hotkey ? (
            <kbd
              className={cn(
                'flex size-5 shrink-0 items-center justify-center rounded border border-border',
                'bg-background text-[0.6875rem] font-medium text-muted-foreground',
              )}
            >
              {option.hotkey}
            </kbd>
          ) : null}
          <span className="min-w-0 flex-1 text-sm text-foreground">{option.label}</span>
          {option.isDefault ? (
            <span className="shrink-0 text-[0.6875rem] text-muted-foreground">pre-picked</span>
          ) : null}
        </label>
      ))}
    </fieldset>
  );
}
