'use client';

import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';

export interface ChatWelcomeProps {
  /** The question the product asks the user, standing in for an empty transcript. */
  title: ReactNode;
  description?: ReactNode;
  /** A mark above the question — a logo, an avatar, nothing. */
  mark?: ReactNode;
  /** The composer. */
  children: ReactNode;
  /** Beneath the composer — `<ChatModePills />`, say. */
  footer?: ReactNode;
  className?: string;
}

/** The first screen: one centred question with the composer under it. */
export function ChatWelcome({
  title,
  description,
  mark,
  children,
  footer,
  className,
}: ChatWelcomeProps) {
  return (
    <div
      className={cn('mx-auto flex w-full max-w-2xl flex-col items-center px-4 py-12', className)}
    >
      {mark ? <div className="mb-8 [&_svg]:size-10">{mark}</div> : null}
      <h1 className="text-center text-3xl font-semibold tracking-tight text-balance text-foreground sm:text-4xl">
        {title}
      </h1>
      {description ? (
        <p className="mt-3 max-w-lg text-center text-sm text-muted-foreground text-balance">
          {description}
        </p>
      ) : null}
      <div className="mt-10 w-full">{children}</div>
      {footer ? <div className="mt-5 w-full">{footer}</div> : null}
    </div>
  );
}
