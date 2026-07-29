import { type VariantProps, cva } from 'class-variance-authority';
import type { HTMLAttributes } from 'react';
import { cn } from './cn';

/**
 * The small bordered chip the console uses for a fact ABOUT a row rather than the row itself — a
 * tool type, an agent name, a truncated prompt hash, a soft-delete marker.
 *
 * Variants are semantic: `warn` is not "amber", it is "this row is in a state someone should notice".
 */
const badgeVariants = cva(
  'mono inline-flex w-fit shrink-0 items-center gap-1 rounded border px-1 text-[10px] leading-4',
  {
    variants: {
      variant: {
        outline: 'border-line text-muted-foreground',
        accent: 'border-line text-brand',
        good: 'border-good/50 text-good',
        warn: 'border-warn/50 text-warn',
        bad: 'border-bad/50 text-bad',
      },
    },
    defaultVariants: { variant: 'outline' },
  },
);

export type BadgeProps = HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>;

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { badgeVariants };
