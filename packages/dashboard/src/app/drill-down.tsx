import { type ReactNode, createContext, useCallback, useContext, useEffect, useState } from 'react';
import { DetailDrawer } from './DetailDrawer';
import { RunDetailPanel } from './RunDetailPanel';
import { InlineError } from './SectionBoundary';
import { ThreadDetailPanel } from './ThreadDetailPanel';
import { hashForSection } from './hash-section';
import { Empty } from './ui';
import { useRunDetail, useThreadDetail } from './use-governance';

/** What a drill-down opens onto. */
export type DrillTarget = { kind: 'run'; runId: string } | { kind: 'thread'; threadId: string };

export interface DrillDown {
  /** Push a target onto the trail — a run opened from a thread keeps the thread behind it. */
  open: (target: DrillTarget) => void;
}

/**
 * Default: opening a drill-down is a no-op. That is what lets the presentational sections be
 * rendered outside the SPA (the mock-data `preview.html` entry) without a provider — they ask for
 * the handler, and a section that has none simply renders its rows as rows.
 */
const DrillDownContext = createContext<DrillDown>({ open: () => {} });

export function useDrillDown(): DrillDown {
  return useContext(DrillDownContext);
}

/**
 * Owns the drill-down trail and renders the drawer.
 *
 * Lives above the sections rather than inside them because the trail crosses sections: a run opened
 * from Reliability leads to its thread, and that thread leads back to another of its runs. A stack
 * is the smallest thing that makes "Back" mean what an operator expects.
 */
export function DrillDownProvider({ children }: { children: ReactNode }) {
  const [trail, setTrail] = useState<DrillTarget[]>([]);

  const open = useCallback((target: DrillTarget) => {
    setTrail((previous) => [...previous, target]);
  }, []);
  const close = useCallback(() => setTrail([]), []);
  const back = useCallback(() => setTrail((previous) => previous.slice(0, -1)), []);

  // A drawer belongs to the section it was opened from. Navigating away — including via the
  // drawer's own "show all runs on this thread" link — must not leave it hanging over the new one.
  useEffect(() => {
    window.addEventListener('hashchange', close);
    return () => window.removeEventListener('hashchange', close);
  }, [close]);

  const current = trail[trail.length - 1];

  return (
    <DrillDownContext.Provider value={{ open }}>
      {children}
      {current !== undefined && (
        <DetailDrawer
          key={targetKey(current)}
          title={current.kind === 'run' ? 'Run' : 'Thread'}
          subtitle={current.kind === 'run' ? current.runId : current.threadId}
          onClose={close}
          {...(trail.length > 1 ? { onBack: back } : {})}
        >
          {current.kind === 'run' ? (
            <RunDetailBody runId={current.runId} onOpenThread={openThread(open)} />
          ) : (
            <ThreadDetailBody threadId={current.threadId} onOpenRun={openRun(open)} />
          )}
        </DetailDrawer>
      )}
    </DrillDownContext.Provider>
  );
}

function targetKey(target: DrillTarget): string {
  return target.kind === 'run' ? `run:${target.runId}` : `thread:${target.threadId}`;
}

function openThread(open: (target: DrillTarget) => void) {
  return (threadId: string) => open({ kind: 'thread', threadId });
}

function openRun(open: (target: DrillTarget) => void) {
  return (runId: string) => open({ kind: 'run', runId });
}

function RunDetailBody({
  runId,
  onOpenThread,
}: {
  runId: string;
  onOpenThread: (threadId: string) => void;
}) {
  const query = useRunDetail(runId);

  if (query.isPending) return <DetailSkeleton label="run" />;
  if (query.isError) {
    return (
      <DetailFailure
        label="This run"
        error={query.error}
        onRetry={() => void query.refetch()}
        goneLabel="This run no longer exists in the read-model."
      />
    );
  }
  return <RunDetailPanel detail={query.data} onOpenThread={onOpenThread} />;
}

function ThreadDetailBody({
  threadId,
  onOpenRun,
}: {
  threadId: string;
  onOpenRun: (runId: string) => void;
}) {
  const query = useThreadDetail(threadId);

  if (query.isPending) return <DetailSkeleton label="thread" />;
  if (query.isError) {
    return (
      <DetailFailure
        label="This thread"
        error={query.error}
        onRetry={() => void query.refetch()}
        goneLabel="This thread no longer exists in the read-model."
      />
    );
  }
  return (
    <ThreadDetailPanel
      detail={query.data}
      onOpenRun={onOpenRun}
      runsHref={hashForSection('reliability', { threadId })}
    />
  );
}

/**
 * A drill-down has three outcomes, not two. `404` is the interesting one: the row an operator
 * clicked named something the read-model no longer has, and saying so is a different answer from
 * "the API is broken". The API 404s on an unknown id precisely so this can be told apart.
 */
function DetailFailure({
  label,
  error,
  onRetry,
  goneLabel,
}: {
  label: string;
  error: unknown;
  onRetry: () => void;
  goneLabel: string;
}) {
  const notFound = error instanceof Error && error.message.startsWith('404');
  if (notFound) return <Empty label={goneLabel} />;
  return <InlineError label={label} error={error} onRetry={onRetry} />;
}

function DetailSkeleton({ label }: { label: string }) {
  return (
    <div className="panel animate-pulse p-6 text-sm text-[var(--muted)]" aria-busy="true">
      Loading {label}…
    </div>
  );
}
