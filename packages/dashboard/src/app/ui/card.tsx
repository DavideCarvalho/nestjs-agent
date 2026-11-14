import type { HTMLAttributes } from 'react';
import { cn } from './cn';

/**
 * The console's surface, in the kit's look (authkit `.card`): the faint top-lit `aviary-surface`
 * fill, a hairline and the kit radius. Panels use the kit's `Panel` (see `./kit`); this is for the
 * banners and one-off boxes that are not titled panels.
 */
export function Card({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return (
    <section
      className={cn('aviary-surface rounded-lg border border-border text-fg', className)}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return <header className={cn('flex items-start justify-between gap-3', className)} {...props} />;
}

export function CardTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h2
      className={cn('text-[12.5px] font-semibold tracking-[0.02em] text-fg', className)}
      {...props}
    />
  );
}

export function CardDescription({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn('mono mt-0.5 text-[10.5px] text-faint', className)} {...props} />;
}

export function CardContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn(className)} {...props} />;
}
