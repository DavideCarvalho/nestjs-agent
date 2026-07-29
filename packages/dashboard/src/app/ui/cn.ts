import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * The shadcn class helper: `clsx` for conditionals, `tailwind-merge` to make the LAST conflicting
 * utility win.
 *
 * Order-independence is the whole point. Without it a caller's `className="px-4"` loses to a
 * primitive's own `px-2` whenever the primitive happens to be declared later in the string, which is
 * how a component ends up with a `className` prop that silently does nothing.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
