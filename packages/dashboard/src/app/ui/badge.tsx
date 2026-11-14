import type { HTMLAttributes } from 'react';
import { badgeVariants as kitBadgeVariants } from '../../aviary-kit/ui/badge';
import { cn } from './cn';

/**
 * The small chip the console uses for a fact ABOUT a row rather than the row itself — a tool type,
 * an agent name, a truncated prompt hash, a soft-delete marker. The kit's shadcn `Badge` look
 * (authkit `.badge`), under this console's variant names. Variants are semantic: `warn` is not
 * "amber", it is "this row is in a state someone should notice".
 */
const VARIANT = {
  outline: 'neutral',
  accent: 'brand',
  good: 'good',
  warn: 'warn',
  bad: 'destructive',
} as const;

export type BadgeVariant = keyof typeof VARIANT;

export function badgeVariants({
  variant = 'outline',
}: { variant?: BadgeVariant | null | undefined } = {}): string {
  return kitBadgeVariants({ variant: VARIANT[variant ?? 'outline'] });
}

export type BadgeProps = HTMLAttributes<HTMLSpanElement> & {
  variant?: BadgeVariant | null | undefined;
};

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
