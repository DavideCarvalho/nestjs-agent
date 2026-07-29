import type { HTMLAttributes } from 'react';
import { cn } from './cn';

/**
 * The console's surface. This is the old `.panel` CSS class, moved into a primitive so the gradient,
 * the hairline and the 12px radius are stated once and in the same vocabulary as everything else.
 *
 * The `rise` entrance stays on the CSS side (`index.css`) — it is an animation, not a token.
 */
export function Card({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return (
    <section
      className={cn(
        'rounded-xl border border-line bg-gradient-to-b from-panel-2 to-panel',
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return <header className={cn('flex items-start justify-between gap-3', className)} {...props} />;
}

export function CardTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={cn('text-sm font-semibold tracking-tight', className)} {...props} />;
}

export function CardDescription({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn('mt-0.5 text-xs text-muted-foreground', className)} {...props} />;
}

export function CardContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn(className)} {...props} />;
}
