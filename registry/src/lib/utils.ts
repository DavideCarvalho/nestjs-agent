import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * The `cn` every shadcn project already has at `@/lib/utils`. It lives here so the registry's own
 * specs and typecheck resolve the import; `shadcn init` writes the consumer's copy, so this file is
 * NOT part of any registry item.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
