import { type ReactNode, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ActorsSection } from './ActorsSection';
import { ApprovalsSection } from './ApprovalsSection';
import { LiveSection } from './LiveSection';
import { ModelsSection } from './ModelsSection';
import { PricingSection } from './PricingSection';
import { ReliabilitySection } from './ReliabilitySection';
import { RunsToolsSection } from './RunsToolsSection';
import { SpendSection } from './SpendSection';
import { ToolsSection } from './ToolsSection';
import { LogoMark } from './icons';
import {
  MOCK_BUDGETS,
  MOCK_LIVE_EVENTS,
  MOCK_PENDING_APPROVALS,
  MOCK_PRICES,
  MOCK_RELIABILITY,
  MOCK_RUNS_PAGE,
  MOCK_SPEND,
  MOCK_THREADS_PAGE,
  MOCK_TOOL_CALLS,
  MOCK_TOOL_CALLS_PAGE,
  MOCK_TOOL_STATS,
  MOCK_TOP_THREADS,
} from './mock-data';
import './index.css';

/**
 * Standalone mock-data entry — no backend, no react-query. Renders every section stacked so the full
 * console can be visually verified with `vite dev`/`vite preview` against `preview.html`.
 */
function Preview() {
  return (
    <div className="relative min-h-full">
      <div className="app-bg" />
      <div className="relative z-10 mx-auto max-w-[1180px] space-y-6 px-5 py-6">
        <header className="flex items-center gap-2.5">
          <div className="grid h-8 w-8 place-items-center rounded-lg border border-[var(--accent)]/40 bg-[var(--accent)]/10">
            <LogoMark className="h-4 w-4 text-[var(--accent)]" />
          </div>
          <div className="leading-none">
            <div className="text-sm font-semibold tracking-tight">AI gateway — preview</div>
            <div className="mono text-[10px] uppercase tracking-[0.2em] text-[var(--muted)]">
              mock data · no backend
            </div>
          </div>
        </header>

        <Group label="Spend & usage">
          <SpendSection overview={MOCK_SPEND} topThreads={MOCK_TOP_THREADS} />
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
            toolCallsPage={MOCK_TOOL_CALLS_PAGE}
            toolCallsWhere={{}}
            onToolCallsToolNameChange={() => {}}
            onToolCallsStatusChange={() => {}}
            onToolCallsPageChange={() => {}}
            threadsPage={MOCK_THREADS_PAGE}
            threadsWhere={{}}
            onThreadsTitleChange={() => {}}
            onThreadsPageChange={() => {}}
          />
        </Group>
        <Group label="Reliability">
          <ReliabilitySection
            overview={MOCK_RELIABILITY}
            runsPage={MOCK_RUNS_PAGE}
            runsWhere={{}}
            onRunsStatusChange={() => {}}
            onRunsAgentNameChange={() => {}}
            onRunsPageChange={() => {}}
          />
        </Group>
        <Group label="Approvals">
          <ApprovalsSection approvals={MOCK_PENDING_APPROVALS} onDecide={async () => {}} />
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
      </div>
    </div>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <h2 className="mono text-[11px] uppercase tracking-[0.2em] text-[var(--muted)]">{label}</h2>
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
