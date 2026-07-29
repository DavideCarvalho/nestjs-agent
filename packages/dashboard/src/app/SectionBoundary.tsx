import { QueryErrorResetBoundary } from '@tanstack/react-query';
import { Component, type ErrorInfo, type ReactNode, Suspense } from 'react';
import { describeError } from '../client/describe-error';
import { AlertIcon, RetryIcon } from './icons';

/**
 * Error isolation for one console section.
 *
 * Before this existed, exactly one of the console's eleven queries had any error surface at all. The
 * other ten failed silently: the section rendered its empty state, which reads as "there is no data"
 * — the single worst thing a governance console can say when the truth is "I could not ask". A
 * boundary per section means a failing read blanks its own panel, names itself, and offers a retry,
 * while the other eight sections keep working.
 */
export function SectionBoundary({ label, children }: { label: string; children: ReactNode }) {
  return (
    <QueryErrorResetBoundary>
      {({ reset }) => (
        <ErrorBoundary
          onReset={reset}
          fallback={(error, retry) => (
            <SectionErrorPanel label={label} error={error} onRetry={retry} />
          )}
        >
          <Suspense fallback={<SectionSkeleton label={label} />}>{children}</Suspense>
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
    <section className="panel rise border-[var(--bad)]/40 p-5">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 text-[var(--bad)]">
          <AlertIcon />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold tracking-tight text-[var(--bad)]">
            {label} failed to load
          </h2>
          <p className="mono mt-1 break-words text-[11px] text-[var(--text)]">
            {described.message}
          </p>
          {described.hint !== '' && (
            <p className="mt-1.5 text-xs text-[var(--muted)]">{described.hint}</p>
          )}
        </div>
        {described.retryable && <RetryButton onRetry={onRetry} />}
      </div>
    </section>
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
    <div className="rounded-lg border border-dashed border-[var(--bad)]/50 p-4">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 shrink-0 text-[var(--bad)]">
          <AlertIcon />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-xs text-[var(--bad)]">{label} failed to load</p>
          <p className="mono mt-1 break-words text-[10px] text-[var(--muted)]">
            {described.message}
          </p>
          {described.hint !== '' && (
            <p className="mt-1 text-[10px] text-[var(--muted)]">{described.hint}</p>
          )}
        </div>
        {described.retryable && <RetryButton onRetry={onRetry} small />}
      </div>
    </div>
  );
}

function RetryButton({ onRetry, small }: { onRetry: () => void; small?: boolean }) {
  return (
    <button
      type="button"
      onClick={onRetry}
      className={`flex shrink-0 items-center gap-1.5 rounded-lg border border-[var(--line)] transition-colors hover:border-[var(--accent)]/50 hover:text-[var(--text)] ${
        small ? 'px-2 py-1 text-[10px]' : 'px-2.5 py-1.5 text-[11px]'
      } text-[var(--muted)]`}
    >
      <RetryIcon /> Retry
    </button>
  );
}

/** The Suspense fallback a section shows while its own reads are in flight. */
export function SectionSkeleton({ label }: { label: string }) {
  return (
    <div className="panel animate-pulse p-6 text-sm text-[var(--muted)]" aria-busy="true">
      Loading {label.toLowerCase()}…
    </div>
  );
}
