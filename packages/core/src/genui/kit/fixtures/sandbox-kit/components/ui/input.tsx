import { cn } from '@/lib/utils';
import type * as React from 'react';

/** A text field. */
export function Input({ className, ...props }: React.ComponentProps<'input'>) {
  return <input className={cn('input', className)} {...props} />;
}
