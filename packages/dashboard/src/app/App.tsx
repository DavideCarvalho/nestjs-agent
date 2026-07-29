import { type ReactNode, useEffect, useState } from 'react';
import type { GovernanceRange } from '../client/agent-client';
import { defaultRange, isIsoDay } from '../client/default-range';
import type { FeedEvent } from '../client/merge-live-events';
import { LiveSection } from './LiveSection';
import { SectionBoundary } from './SectionBoundary';
import { ActorsContainer } from './containers/ActorsContainer';
import { ApprovalsContainer } from './containers/ApprovalsContainer';
import { ModelsContainer } from './containers/ModelsContainer';
import { PricingContainer } from './containers/PricingContainer';
import { ReliabilityContainer } from './containers/ReliabilityContainer';
import { RunsToolsContainer } from './containers/RunsToolsContainer';
import { SpendContainer } from './containers/SpendContainer';
import { ToolsContainer } from './containers/ToolsContainer';
import { DrillDownProvider } from './drill-down';
import { DEFAULT_SECTION, type SectionKey, hashForSection, routeFromHash } from './hash-section';
import {
  ActivityIcon,
  ChipIcon,
  DollarIcon,
  InboxIcon,
  LogoMark,
  ShieldIcon,
  TagIcon,
  UsersIcon,
  WrenchIcon,
} from './icons';
import { useApprovalsCount } from './use-governance';
import { useLiveEvents } from './use-live-events';

const NAV: { key: SectionKey; label: string; icon: ReactNode }[] = [
  { key: 'spend', label: 'Spend & usage', icon: <DollarIcon /> },
  { key: 'models', label: 'Models', icon: <ChipIcon /> },
  { key: 'actors', label: 'Actors & budgets', icon: <UsersIcon /> },
  { key: 'runs', label: 'Runs & tools', icon: <WrenchIcon /> },
  { key: 'reliability', label: 'Reliability', icon: <ShieldIcon /> },
  { key: 'approvals', label: 'Approvals', icon: <InboxIcon /> },
  { key: 'tools', label: 'Tools', icon: <WrenchIcon /> },
  { key: 'pricing', label: 'Pricing', icon: <TagIcon /> },
  { key: 'live', label: 'Live', icon: <ActivityIcon /> },
];

const SECTION_LABEL: Record<SectionKey, string> = Object.fromEntries(
  NAV.map((item) => [item.key, item.label]),
) as Record<SectionKey, string>;

/**
 * The active hash route (`#/reliability?threadId=th2`, see `hash-section.ts`) — read on mount for a
 * working deep link, kept in sync via the `hashchange` listener. Nav items are real anchors, so
 * clicking one is a normal hash navigation; no router dependency.
 */
function useHashRoute(): { section: SectionKey; params: URLSearchParams } {
  const [route, setRoute] = useState(() =>
    typeof window === 'undefined'
      ? { section: DEFAULT_SECTION, params: new URLSearchParams() }
      : routeFromHash(window.location.hash),
  );

  useEffect(() => {
    function onHashChange() {
      setRoute(routeFromHash(window.location.hash));
    }
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  return route;
}

/**
 * The AI-gateway console shell: brand, section nav, a UTC day-range picker, and the live-connection
 * indicator.
 *
 * The shell holds exactly TWO data sources, and both are here because they have to outlive the
 * section being viewed: the SSE subscription (closing and reopening it on every nav would reset the
 * feed and make the header's connection dot lie) and the pending-approvals COUNT that the nav badge
 * shows while the operator is looking at some other section. Everything else belongs to the
 * container for the section that renders it — see `./containers`.
 */
export function App() {
  const [range, setRange] = useState<GovernanceRange>(defaultRange());
  const { section, params } = useHashRoute();
  const live = useLiveEvents();
  const approvalsCount = useApprovalsCount();

  return (
    <DrillDownProvider>
      <div className="relative min-h-full">
        <div className="app-bg" />
        <div className="relative z-10 mx-auto max-w-[1180px] px-5 py-5">
          <Header
            range={range}
            onRange={setRange}
            connected={live.connected}
            liveCount={live.events.length}
          />

          <nav className="mb-5 flex flex-wrap gap-1">
            {NAV.map((item) => {
              const badgeCount =
                item.key === 'live'
                  ? live.events.length
                  : item.key === 'approvals'
                    ? (approvalsCount.data ?? 0)
                    : 0;
              return (
                <a
                  key={item.key}
                  href={hashForSection(item.key)}
                  className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs transition-colors ${
                    section === item.key
                      ? 'border-[var(--accent)]/50 bg-[var(--accent)]/10 text-[var(--text)]'
                      : 'border-transparent text-[var(--muted)] hover:text-[var(--text)]'
                  }`}
                >
                  {item.icon}
                  {item.label}
                  {badgeCount > 0 && (
                    <span className="mono tnum rounded bg-[var(--accent)]/20 px-1 text-[10px] text-[var(--accent)]">
                      {badgeCount}
                    </span>
                  )}
                </a>
              );
            })}
          </nav>

          {/* Keyed on the section so a nav discards the failed boundary of the section being left,
              instead of carrying its error state onto the one being opened. */}
          <SectionBoundary key={section} label={SECTION_LABEL[section]}>
            <ActiveSection
              section={section}
              range={range}
              params={params}
              liveEvents={live.events}
              connected={live.connected}
            />
          </SectionBoundary>
        </div>
      </div>
    </DrillDownProvider>
  );
}

/**
 * Mounts exactly one container. This is the whole point of the restructure: nine sections used to
 * mean nine sections' worth of queries on every page load, because every hook was called in `App`
 * and only the RENDER was switched. A section that is not on screen now issues no requests.
 */
function ActiveSection({
  section,
  range,
  params,
  liveEvents,
  connected,
}: {
  section: SectionKey;
  range: GovernanceRange;
  params: URLSearchParams;
  liveEvents: FeedEvent[];
  connected: boolean;
}) {
  switch (section) {
    case 'spend':
      return <SpendContainer range={range} />;
    case 'models':
      return <ModelsContainer range={range} />;
    case 'actors':
      return <ActorsContainer range={range} />;
    case 'runs':
      return <RunsToolsContainer />;
    case 'reliability':
      return <ReliabilityContainer range={range} threadId={params.get('threadId') ?? undefined} />;
    case 'approvals':
      return <ApprovalsContainer />;
    case 'tools':
      return <ToolsContainer range={range} />;
    case 'pricing':
      return <PricingContainer />;
    // The live feed has no container: its subscription belongs to the shell (see `App`), so this
    // section is the presentational component fed the shell's events.
    case 'live':
      return <LiveSection events={liveEvents} connected={connected} />;
    default:
      return null;
  }
}

function Header({
  range,
  onRange,
  connected,
  liveCount,
}: {
  range: GovernanceRange;
  onRange: (range: GovernanceRange) => void;
  connected: boolean;
  liveCount: number;
}) {
  return (
    <header className="mb-5 flex flex-wrap items-center gap-4">
      <div className="flex items-center gap-2.5">
        <div className="grid h-8 w-8 place-items-center rounded-lg border border-[var(--accent)]/40 bg-[var(--accent)]/10">
          <LogoMark className="h-4 w-4 text-[var(--accent)]" />
        </div>
        <div className="leading-none">
          <div className="text-sm font-semibold tracking-tight">AI gateway</div>
          <div className="mono text-[10px] uppercase tracking-[0.2em] text-[var(--muted)]">
            governance console
          </div>
        </div>
      </div>

      <div className="ml-auto flex flex-wrap items-center gap-2">
        <DayInput
          label="From"
          value={range.fromDay}
          onChange={(fromDay) => onRange({ ...range, fromDay })}
        />
        <DayInput
          label="To"
          value={range.toDay}
          onChange={(toDay) => onRange({ ...range, toDay })}
        />
        <span className="flex items-center gap-1.5 rounded-lg border border-[var(--line)] px-2.5 py-1.5 text-[11px] text-[var(--muted)]">
          <span className={`dot ${connected ? 's-ok pulse' : 's-failed'}`} aria-hidden />
          live {liveCount > 0 ? `· ${liveCount}` : ''}
        </span>
      </div>
    </header>
  );
}

function DayInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (day: string) => void;
}) {
  return (
    <label className="flex items-center gap-1.5 rounded-lg border border-[var(--line)] bg-[var(--panel)] px-2.5 py-1 text-[11px] text-[var(--muted)]">
      <span className="uppercase tracking-wider">{label}</span>
      <input
        type="date"
        value={value}
        onChange={(event) => {
          const next = event.target.value;
          if (isIsoDay(next)) onChange(next);
        }}
        className="mono bg-transparent text-[var(--text)] outline-none"
      />
    </label>
  );
}
