import type { HTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from 'react';
import { cn } from './cn';

/**
 * The console's five data tables, as one set of parts.
 *
 * They had drifted: the same `py-2.5 pr-4 text-[var(--muted)]` cell was written out five times, the
 * header row's tracking differed between two of them, and only three of the five were wrapped in the
 * `overflow-x-auto` that keeps a `min-w` table from pushing the page sideways. `Table` now owns that
 * wrapper, so forgetting it is no longer possible.
 */
export function Table({ className, ...props }: HTMLAttributes<HTMLTableElement>) {
  return (
    <div className="w-full overflow-x-auto">
      <table className={cn('w-full text-left text-xs', className)} {...props} />
    </div>
  );
}

export function TableHeader({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <thead
      className={cn('text-[10px] uppercase tracking-wider text-muted-foreground', className)}
      {...props}
    />
  );
}

export function TableBody({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={cn('mono tnum', className)} {...props} />;
}

export function TableRow({ className, ...props }: HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={cn('border-b border-line-soft', className)} {...props} />;
}

/** The header row itself — a full-weight hairline under it, unlike the soft rules between rows. */
export function TableHeadRow({ className, ...props }: HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={cn('border-b border-line', className)} {...props} />;
}

export function TableHead({ className, ...props }: ThHTMLAttributes<HTMLTableCellElement>) {
  return <th className={cn('py-2 font-medium', className)} {...props} />;
}

export function TableCell({ className, ...props }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn('py-2.5 text-muted-foreground', className)} {...props} />;
}
