import { useRender } from '@base-ui-components/react/use-render';
import { type VariantProps, cva } from 'class-variance-authority';
import type { ButtonHTMLAttributes } from 'react';
import { cn } from './cn';

/**
 * Every clickable affordance in the console, as one set of variants.
 *
 * The console used to hand-roll each one — nine near-identical `rounded-md border border-[var(--line)]
 * px-2 py-1 …` strings that had already diverged on padding, radius and hover. The variants below are
 * those strings, deduplicated and named after what they MEAN (`success` = approve, `danger` = reject)
 * rather than what they look like, so a status colour can move in AVIARY-UI.md without a grep.
 */
const buttonVariants = cva(
  'inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        /** The one affirmative action on a surface — "Save price". */
        default: 'border-brand/50 bg-brand/10 text-foreground hover:bg-brand/20',
        /** The console's workhorse: a quiet outlined control that warms on hover. */
        outline: 'border-line text-muted-foreground hover:border-brand/50 hover:text-foreground',
        /** No chrome until hovered — nav items, row buttons. */
        ghost: 'border-transparent text-muted-foreground hover:bg-panel-2 hover:text-foreground',
        /** Carries the accent as its TEXT, not just its tint — a removable filter chip. */
        accent: 'border-brand/50 bg-brand/10 text-brand hover:bg-brand/20',
        success: 'border-good/50 bg-good/10 text-good hover:bg-good/20',
        danger: 'border-bad/50 bg-bad/10 text-bad hover:bg-bad/20',
      },
      size: {
        xs: 'px-2 py-1 text-[10px]',
        sm: 'px-2.5 py-1 text-[11px]',
        md: 'px-3 py-1.5 text-xs',
        icon: 'p-1.5',
      },
    },
    defaultVariants: { variant: 'outline', size: 'sm' },
  },
);

export interface ButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'>,
    VariantProps<typeof buttonVariants> {
  className?: string;
  /**
   * Render something else with this button's styling — Base UI's `render`, which is what replaces
   * Radix's `asChild`. Pass an element (`render={<a href="…" />}`) and its props are merged in,
   * rather than a wrapper being introduced around it.
   */
  render?: useRender.RenderProp;
}

export function Button({ className, variant, size, render, ...props }: ButtonProps) {
  return useRender({
    defaultTagName: 'button',
    ...(render === undefined ? {} : { render }),
    props: { ...props, className: cn(buttonVariants({ variant, size }), className) },
  });
}

export { buttonVariants };
