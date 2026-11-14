import { QueryErrorResetBoundary } from '@tanstack/react-query';
import { Component, type ErrorInfo, type ReactNode, Suspense } from 'react';
import { MetricGridSkeleton } from '../aviary-kit/blocks/metric-card';
import { Skeleton } from '../aviary-kit/ui/skeleton';
import { describeError } from '../client/describe-error';
import { AlertIcon, RetryIcon } from './icons';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { cn } from './ui/cn';

/**
 * Error isolation for one console section.
 *
 * Before this existed, exactly one of the console's eleven queries had any error surface at all. The
 * other ten failed silently: the section rendered its empty state, which reads as "there is no data"
 * — the single worst thing a governance console can say when the truth is "I could not ask". A
 * boundary per section means a failing read blanks its own panel, names itself, and offers a retry,
 * while the other eight sections keep working.
 */
export function SectionBoundary({
  label,
  children,
  metrics,
}: {
  label: string;
  children: ReactNode;
  /** Metric cards in the loading skeleton (default 4; 0 for a page that opens on a table). */
  metrics?: number;
}) {
  return (
    <QueryErrorResetBoundary>
      {({ reset }) => (
        <ErrorBoundary
          onReset={reset}
          fallback={(error, retry) => (
            <SectionErrorPanel label={label} error={error} onRetry={retry} />
          )}
        >
          <Suspense
            fallback={
              <SectionSkeleton label={label} {...(metrics !== undefined ? { metrics } : {})} />
            }
          >
            {children}
          </Suspense>
        </ErrorBoundary>
      )}
    </QueryErrorResetBoundary>
  );
}

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Rendered instead of `children` once something below has thrown. `retry` clears the error. */
  fallback: (error: unknown, retry: () => void) => ReactNode;
  /**
   * Run before the boundary clears its error — `QueryErrorResetBoundary`'s `reset`, which clears the
   * cached rejection so the remounted children issue a fresh request instead of re-throwing it.
   */
  onReset?: () => void;
}

interface ErrorBoundaryState {
  /** Tracked separately from `error` because a component is allowed to throw a falsy value. */
  failed: boolean;
  error: unknown;
}

/**
 * The only class component in this app: `componentDidCatch` has no hook equivalent. Deliberately
 * dumb — it holds the thrown value and hands it to `fallback`; deciding what a given failure MEANS
 * belongs to `describeError`, which is a pure function with its own tests.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { failed: false, error: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { failed: true, error };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    // The console is the thing operators open when something is wrong; a failure inside it must not
    // be the one failure nobody can see. `console.error` is the only sink a bundled SPA has.
    console.error('[ai-gateway] section failed to render', error, info.componentStack);
  }

  private readonly retry = (): void => {
    this.props.onReset?.();
    this.setState({ failed: false, error: null });
  };

  override render(): ReactNode {
    if (this.state.failed) {
      return this.props.fallback(this.state.error, this.retry);
    }
    return this.props.children;
  }
}

/**
 * The section-sized failure state: what failed, what the server actually said, what to do about it,
 * and — when retrying could plausibly help — a button that retries.
 */
export function SectionErrorPanel({
  label,
  error,
  onRetry,
}: {
  label: string;
  error: unknown;
  onRetry: () => void;
}) {
  const described = describeError(error);
  return (
    <Card className="rise border-bad/40 p-5">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 text-bad">
          <AlertIcon />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold tracking-tight text-bad">{label} failed to load</h2>
          <p className="mono mt-1 break-words text-[11px] text-fg-2">{described.message}</p>
          {described.hint !== '' && (
            <p className="mt-1.5 text-xs text-muted-foreground">{described.hint}</p>
          )}
        </div>
        {described.retryable && <RetryButton onRetry={onRetry} />}
      </div>
    </Card>
  );
}

/**
 * The failure state for ONE table inside an otherwise-working section — a page that 500'd, a filter
 * the parser rejected. Rendered in place of the rows so the section's headline numbers, which came
 * from a different query and are still true, stay on screen.
 */
export function InlineError({
  label,
  error,
  onRetry,
}: {
  label: string;
  error: unknown;
  onRetry: () => void;
}) {
  const described = describeError(error);
  return (
    <div className="rounded-lg border border-dashed border-bad/50 p-4">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 shrink-0 text-bad">
          <AlertIcon />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-xs text-bad">{label} failed to load</p>
          <p className="mono mt-1 break-words text-[10px] text-muted-foreground">
            {described.message}
          </p>
          {described.hint !== '' && (
            <p className="mt-1 text-[10px] text-muted-foreground">{described.hint}</p>
          )}
        </div>
        {described.retryable && <RetryButton onRetry={onRetry} small />}
      </div>
    </div>
  );
}

function RetryButton({ onRetry, small }: { onRetry: () => void; small?: boolean }) {
  return (
    <Button onClick={onRetry} size={small ? 'xs' : 'sm'} className="rounded-lg">
      <RetryIcon /> Retry
    </Button>
  );
}

/**
 * The Suspense fallback a section shows while its own reads are in flight: skeletons shaped like a
 * section (a row of metric cards, then two panels), never a bare spinner. The label stays for
 * screen readers as a polite status.
 */
export function SectionSkeleton({ label, metrics = 4 }: { label: string; metrics?: number }) {
  return (
    <div className="flex flex-col gap-4" aria-busy="true">
      <output className="sr-only">Loading {label.toLowerCase()}…</output>
      {metrics > 0 && <MetricGridSkeleton count={metrics} />}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3" aria-hidden>
        <PanelSkeleton rows={4} />
        <PanelSkeleton rows={4} className="lg:col-span-2" />
      </div>
    </div>
  );
}

function PanelSkeleton({ rows, className }: { rows: number; className?: string }) {
  return (
    <Card className={cn('flex flex-col gap-3 px-4 pt-3 pb-4', className)}>
      <Skeleton className="h-3 w-32" />
      <div className="mt-1 flex flex-col gap-2.5 border-t border-border pt-3">
        {Array.from({ length: rows }, (_, i) => `row-${i}`).map((key) => (
          <Skeleton key={key} className="h-3.5 w-full" />
        ))}
      </div>
    </Card>
  );
}
