import { type ReactNode, StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ActorsSection } from './ActorsSection';
import { ApprovalsSection } from './ApprovalsSection';
import { DetailDrawer } from './DetailDrawer';
import { LiveSection } from './LiveSection';
import { ModelsSection } from './ModelsSection';
import { PricingSection } from './PricingSection';
import { ReliabilitySection } from './ReliabilitySection';
import { RunDetailPanel } from './RunDetailPanel';
import { RunsToolsSection } from './RunsToolsSection';
import { SectionErrorPanel, SectionSkeleton } from './SectionBoundary';
import { SpendSection } from './SpendSection';
import { ThreadDetailPanel } from './ThreadDetailPanel';
import { ToolsSection } from './ToolsSection';
import { LogoMark } from './icons';
import {
  MOCK_APPROVALS_PAGE,
  MOCK_BUDGETS,
  MOCK_LIVE_EVENTS,
  MOCK_PRICES,
  MOCK_RELIABILITY,
  MOCK_RUNS_PAGE,
  MOCK_RUN_DETAIL,
  MOCK_SPEND,
  MOCK_THREADS_PAGE,
  MOCK_THREAD_DETAIL,
  MOCK_TOOL_CALLS,
  MOCK_TOOL_CALLS_PAGE,
  MOCK_TOOL_STATS,
  MOCK_TOP_THREADS,
} from './mock-data';
import type { PagedTable } from './paged-table';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { TooltipProvider } from './ui/tooltip';
import './index.css';

/** Wrap a mock page in the `PagedTable` shape the section components render from. */
function ok<TRow>(page: PagedTable<TRow>['page']): PagedTable<TRow> {
  return { page, error: null, retry: () => {} };
}

/** A `PagedTable` whose last fetch failed while the previous page's rows are still on screen. */
function failed<TRow>(page: PagedTable<TRow>['page'], error: unknown): PagedTable<TRow> {
  return { page, error, retry: () => {} };
}

type OpenDetail = 'run' | 'thread' | null;

/**
 * Standalone mock-data entry — no backend, no react-query. Renders every section stacked so the
 * full console can be visually verified with `vite dev`/`vite preview` against `preview.html`.
 *
 * It also renders the states that only exist when something goes wrong (a failed section, a failed
 * table inside a working section, a section still loading) — those are exactly the states no
 * backend-less check would otherwise reach, and the ones that used to not exist at all.
 */
function Preview() {
  const [open, setOpen] = useState<OpenDetail>(null);

  return (
    <TooltipProvider delay={400} closeDelay={0} timeout={300}>
      <div className="relative min-h-full">
        <div className="app-bg" />
        <div className="relative z-10 mx-auto max-w-[1180px] space-y-6 px-5 py-6">
          <header className="flex items-center gap-2.5">
            <div className="grid h-8 w-8 place-items-center rounded-lg border border-brand/40 bg-brand/10">
              <LogoMark className="h-4 w-4 text-brand" />
            </div>
            <div className="leading-none">
              <div className="text-sm font-semibold tracking-tight">AI gateway — preview</div>
              <div className="mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                mock data · no backend
              </div>
            </div>
          </header>

          <Group label="Spend & usage">
            <SpendSection
              overview={MOCK_SPEND}
              topThreads={MOCK_TOP_THREADS}
              onOpenThread={() => setOpen('thread')}
            />
          </Group>
          <Group label="Models">
            <ModelsSection rows={MOCK_SPEND.byModel} />
          </Group>
          <Group label="Actors & budgets">
            <ActorsSection rows={MOCK_SPEND.byActor} budgets={MOCK_BUDGETS} />
          </Group>
          <Group label="Runs & tools">
            <RunsToolsSection
              toolCalls={MOCK_TOOL_CALLS}
              toolCallsTable={ok(MOCK_TOOL_CALLS_PAGE)}
              toolCallsWhere={{}}
              onToolCallsToolNameChange={() => {}}
              onToolCallsStatusChange={() => {}}
              onToolCallsPageChange={() => {}}
              threadsTable={ok(MOCK_THREADS_PAGE)}
              threadsWhere={{}}
              onThreadsTitleChange={() => {}}
              onThreadsPageChange={() => {}}
              onOpenRun={() => setOpen('run')}
              onOpenThread={() => setOpen('thread')}
            />
          </Group>
          <Group label="Reliability">
            <ReliabilitySection
              overview={MOCK_RELIABILITY}
              runsTable={ok(MOCK_RUNS_PAGE)}
              runsWhere={{ threadId: 'th2' }}
              onRunsStatusChange={() => {}}
              onRunsAgentNameChange={() => {}}
              onRunsThreadIdClear={() => {}}
              onRunsPageChange={() => {}}
              onOpenRun={() => setOpen('run')}
            />
          </Group>
          <Group label="Approvals">
            <ApprovalsSection
              table={ok(MOCK_APPROVALS_PAGE)}
              onPageChange={() => {}}
              onDecide={async () => {}}
              onOpenRun={() => setOpen('run')}
            />
          </Group>
          <Group label="Tools">
            <ToolsSection rows={MOCK_TOOL_STATS} />
          </Group>
          <Group label="Pricing">
            <PricingSection
              prices={MOCK_PRICES}
              loading={false}
              unavailable={false}
              onUpsert={async () => {}}
              saving={false}
            />
          </Group>
          <Group label="Live">
            <LiveSection events={MOCK_LIVE_EVENTS} connected />
          </Group>

          <Group label="Failure & loading states">
            <div className="space-y-4">
              <SectionErrorPanel
                label="Spend & usage"
                error={new Error('503 Service Unavailable')}
                onRetry={() => {}}
              />
              <SectionErrorPanel
                label="Pricing"
                error={new Error('401 Unauthorized')}
                onRetry={() => {}}
              />
              <SectionSkeleton label="Reliability" />
              <RunsToolsSection
                toolCalls={MOCK_TOOL_CALLS}
                toolCallsTable={failed(
                  MOCK_TOOL_CALLS_PAGE,
                  new Error('500 Internal Server Error'),
                )}
                toolCallsWhere={{}}
                onToolCallsToolNameChange={() => {}}
                onToolCallsStatusChange={() => {}}
                onToolCallsPageChange={() => {}}
                threadsTable={ok(MOCK_THREADS_PAGE)}
                threadsWhere={{}}
                onThreadsTitleChange={() => {}}
                onThreadsPageChange={() => {}}
              />
            </div>
          </Group>

          <Group label="Drill-downs">
            <Card className="flex flex-wrap gap-2 p-4 text-xs">
              <Button size="md" className="rounded-lg" onClick={() => setOpen('run')}>
                Open a run
              </Button>
              <Button size="md" className="rounded-lg" onClick={() => setOpen('thread')}>
                Open a thread
              </Button>
            </Card>
          </Group>
        </div>

        {open !== null && (
          <DetailDrawer
            title={open === 'run' ? 'Run' : 'Thread'}
            subtitle={
              open === 'run' ? MOCK_RUN_DETAIL.run.runId : MOCK_THREAD_DETAIL.thread.threadId
            }
            onClose={() => setOpen(null)}
            {...(open === 'run' ? { onBack: () => setOpen('thread') } : {})}
          >
            {open === 'run' ? (
              <RunDetailPanel detail={MOCK_RUN_DETAIL} onOpenThread={() => setOpen('thread')} />
            ) : (
              <ThreadDetailPanel
                detail={MOCK_THREAD_DETAIL}
                onOpenRun={() => setOpen('run')}
                runsHref="#/reliability?threadId=th2"
              />
            )}
          </DetailDrawer>
        )}
      </div>
    </TooltipProvider>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <h2 className="mono text-[11px] uppercase tracking-[0.2em] text-muted-foreground">{label}</h2>
      {children}
    </div>
  );
}

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <StrictMode>
      <Preview />
    </StrictMode>,
  );
}
