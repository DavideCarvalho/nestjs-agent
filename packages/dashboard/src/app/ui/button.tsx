import { useRender } from '@base-ui/react/use-render';
import type { ButtonHTMLAttributes } from 'react';
import { buttonVariants as kitButtonVariants } from '../../aviary-kit/ui/button';
import { cn } from './cn';

/**
 * The console's button: the kit's shadcn `Button` look (authkit `.btn`), under the variant names
 * this console's call sites already use. Variants are named after what they MEAN (`success` =
 * approve, `danger` = reject), so a status colour can move in the kit without a grep.
 */
const VARIANT = {
  /** The one affirmative action on a surface — "Save price". Solid accent. */
  default: 'default',
  /** The console's workhorse: a raised, hairline-bordered control. */
  outline: 'outline',
  /** No chrome until hovered — row buttons, close affordances. */
  ghost: 'ghost',
  /** Carries the accent as its text and tint — a removable filter chip. */
  accent: 'brand',
  /** Approve. The kit has no green button tint; it is the outline button tinted good. */
  success: 'outline',
  /** Reject / destructive. */
  danger: 'destructive',
} as const;

const SIZE = {
  xs: 'micro',
  sm: 'sm',
  md: 'default',
  icon: 'icon-xs',
} as const;

export type ButtonVariant = keyof typeof VARIANT;
export type ButtonSize = keyof typeof SIZE;

export function buttonVariants({
  variant = 'outline',
  size = 'sm',
}: {
  variant?: ButtonVariant | null | undefined;
  size?: ButtonSize | null | undefined;
} = {}): string {
  const v = variant ?? 'outline';
  return cn(
    kitButtonVariants({ variant: VARIANT[v], size: SIZE[size ?? 'sm'] }),
    v === 'success' &&
      'border-good/40 bg-good/10 text-good hover:border-good/50 hover:bg-good/20 hover:text-good',
  );
}

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  variant?: ButtonVariant | null | undefined;
  size?: ButtonSize | null | undefined;
  className?: string;
  /**
   * Render something else with this button's styling — Base UI's `render`, which is what replaces
   * Radix's `asChild`. Pass an element (`render={<a href="…" />}`) and its props are merged in.
   */
  render?: useRender.RenderProp;
}

export function Button({ className, variant, size, render, type, ...props }: ButtonProps) {
  return useRender({
    defaultTagName: 'button',
    ...(render === undefined ? {} : { render }),
    props: {
      // Never submit a form by accident unless asked to (the pricing form's save sets `submit`).
      ...(render === undefined ? { type: type ?? 'button' } : type ? { type } : {}),
      ...props,
      className: cn(buttonVariants({ variant, size }), className),
    },
  });
}
