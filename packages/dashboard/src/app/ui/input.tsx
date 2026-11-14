import type { InputHTMLAttributes } from 'react';
import { cn } from './cn';

/**
 * A bordered text/number/date field.
 *
 * `bg-panel` rather than transparent so a field reads as a field on the gradient surfaces the
 * console puts them on, and the focus ring is the accent — the one place the brand colour is allowed
 * to mean "you are here".
 */
export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'mono h-[26px] rounded-md border border-border bg-panel-2 px-2 text-[11px] text-fg outline-none transition-colors placeholder:text-faint hover:border-line-strong focus:border-brand-border focus:ring-3 focus:ring-ring/30 disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

/**
 * The same field with no box of its own — for an input nested inside a labelled container that
 * already draws the border (the pricing form, the day-range picker).
 */
export function BareInput({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn('mono bg-transparent text-fg outline-none placeholder:text-faint', className)}
      {...props}
    />
  );
}
