import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { PageHeader } from '../aviary-kit/blocks/page-header';
import { readShellConfig } from '../aviary-kit/shell-config';
import { AppShell, type NavSection, PageBody } from '../aviary-kit/shell/app-shell';
import type { SearchCommand } from '../aviary-kit/shell/console-search';
import type { GovernanceRange } from '../client/agent-client';
import { defaultRange, isIsoDay } from '../client/default-range';
import type { FeedEvent } from '../client/merge-live-events';
import { AccessDenied } from './AccessDenied';
import { LiveSection } from './LiveSection';
import { OrganizationChip } from './OrganizationChip';
import { SectionBoundary } from './SectionBoundary';
import { ActorsContainer } from './containers/ActorsContainer';
import { ApprovalsContainer } from './containers/ApprovalsContainer';
import { GenuiContainer } from './containers/GenuiContainer';
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
  CalendarIcon,
  ChipIcon,
  DollarIcon,
  InboxIcon,
  LayoutIcon,
  LogoMark,
  ShieldIcon,
  TagIcon,
  UsersIcon,
  WrenchIcon,
} from './icons';
import { Button } from './ui/button';
import { BareInput } from './ui/input';
import { StatusDot } from './ui/kit';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { useConsoleAccess } from './use-console-access';
import { useApprovalsCount } from './use-governance';
import { useLiveEvents } from './use-live-events';

/** The id of the page's JSON config block (the server's `AGENT_DASHBOARD_CONFIG_ID`). */
export const CONFIG_ELEMENT_ID = 'agent-dashboard-config';

/** The agent console's accent (violet): passed to the kit's ThemeProvider in `main.tsx`. */
export const AGENT_ACCENT = '#a78bfa';

interface Page {
  key: SectionKey;
  label: string;
  icon: ReactNode;
  /** The page header's one-line subtitle. */
  description: string;
  /** Metric cards in this page's loading skeleton (0: none). */
  metrics: number;
}

/** Every page, by sidebar section. The hash routes (`#/spend`, …) are unchanged. */
const SECTIONS: { section: string; pages: Page[] }[] = [
  {
    section: 'Monitor',
    pages: [
      {
        key: 'spend',
        label: 'Spend & usage',
        icon: <DollarIcon />,
        description: 'What the gateway spent, on which models, and the daily trend.',
        metrics: 4,
      },
      {
        key: 'models',
        label: 'Models',
        icon: <ChipIcon />,
        description: 'Requests, tokens and cost per model over the range.',
        metrics: 0,
      },
      {
        key: 'reliability',
        label: 'Reliability',
        icon: <ShieldIcon />,
        description: 'Success and error rates, failures by code, retries and recent runs.',
        metrics: 5,
      },
      {
        key: 'live',
        label: 'Live',
        icon: <ActivityIcon />,
        description: 'Agent events as they happen, streamed from the gateway.',
        metrics: 0,
      },
    ],
  },
  {
    section: 'Activity',
    pages: [
      {
        key: 'runs',
        label: 'Runs & tools',
        icon: <WrenchIcon />,
        description: 'Recent tool calls and threads; open a row for its run or conversation.',
        metrics: 0,
      },
      {
        key: 'genui',
        label: 'Generative UI',
        icon: <LayoutIcon />,
        description: 'Whether the model gets UI right on the first try, and what breaks.',
        metrics: 5,
      },
    ],
  },
  {
    section: 'Governance',
    pages: [
      {
        key: 'approvals',
        label: 'Approvals',
        icon: <InboxIcon />,
        description: 'Action tool calls waiting for a human decision.',
        metrics: 0,
      },
      {
        key: 'actors',
        label: 'Actors & budgets',
        icon: <UsersIcon />,
        description: 'Who is spending, against which budget.',
        metrics: 0,
      },
    ],
  },
  {
    section: 'Config',
    pages: [
      {
        key: 'tools',
        label: 'Tools',
        icon: <WrenchIcon />,
        description: 'Every tool the agents called: volume, failures and latency.',
        metrics: 0,
      },
      {
        key: 'pricing',
        label: 'Pricing',
        icon: <TagIcon />,
        description: 'The per-model rates cost is priced against.',
        metrics: 0,
      },
    ],
  },
];

const PAGES: Record<SectionKey, Page> = Object.fromEntries(
  SECTIONS.flatMap((s) => s.pages).map((page) => [page.key, page]),
) as Record<SectionKey, Page>;

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

function go(section: SectionKey): void {
  window.location.hash = hashForSection(section);
}

/**
 * The AI-gateway console: the Aviary shell (kit) around the governance pages — MONITOR, ACTIVITY,
 * GOVERNANCE and CONFIG — with the organization and day-range pickers and the live indicator in the
 * topbar.
 *
 * The shell holds exactly TWO data sources, and both are here because they have to outlive the page
 * being viewed: the SSE subscription (closing and reopening it on every nav would reset the feed and
 * make the live indicator lie) and the pending-approvals COUNT that the nav badge shows while the
 * operator is looking at some other page. Everything else belongs to the container for the page
 * that renders it — see `./containers`.
 */
export function App() {
  // What the server put in the page: switcher, ⌘K search, viewer, sign-out (all optional).
  const shell = useMemo(() => readShellConfig(CONFIG_ELEMENT_ID), []);
  const [range, setRange] = useState<GovernanceRange>(defaultRange());
  const { section, params } = useHashRoute();
  const live = useLiveEvents();
  const approvalsCount = useApprovalsCount();
  const access = useConsoleAccess();
  const approvals = approvalsCount.data ?? 0;
  const liveCount = live.events.length;

  const nav = useMemo<NavSection[]>(
    () =>
      SECTIONS.map(({ section: name, pages }) => ({
        section: name,
        items: pages.map((page) => {
          const badge =
            page.key === 'approvals' && approvals > 0
              ? approvals
              : page.key === 'live' && liveCount > 0
                ? liveCount
                : undefined;
          return {
            id: page.key,
            label: page.label,
            icon: page.icon,
            href: hashForSection(page.key),
            onSelect: () => go(page.key),
            ...(badge !== undefined ? { badge } : {}),
          };
        }),
      })),
    [approvals, liveCount],
  );

  // ⌘K: this console's pages, listed above the cross-console hits.
  const commands = useMemo<SearchCommand[]>(
    () =>
      SECTIONS.flatMap(({ section: name, pages }) =>
        pages.map((page) => ({
          id: `page:${page.key}`,
          label: page.label,
          group: 'Pages',
          icon: page.icon,
          keywords: [name],
          onSelect: () => go(page.key),
        })),
      ),
    [],
  );

  if (access.denied) return <AccessDenied />;

  const page = PAGES[section];
  return (
    <DrillDownProvider>
      <AppShell
        brand={{
          name: 'ai gateway',
          subtitle: 'governance',
          mark: <LogoMark />,
          current: { title: 'Agents', package: '@dudousxd/nestjs-agent', icon: 'agent' },
        }}
        nav={nav}
        activeId={section}
        shell={shell}
        title={page.label}
        commands={commands}
        searchPlaceholder="Search runs, threads, workflows, media…"
        actions={
          <>
            <OrganizationChip />
            <RangePicker range={range} onRange={setRange} />
            <LiveIndicator connected={live.connected} />
          </>
        }
      >
        <PageBody>
          <PageHeader title={page.label} description={page.description} />
          {/* Keyed on the section so a nav discards the failed boundary of the page being left,
              instead of carrying its error state onto the one being opened. */}
          <SectionBoundary key={section} label={page.label} metrics={page.metrics}>
            <ActiveSection
              section={section}
              range={range}
              params={params}
              liveEvents={live.events}
              connected={live.connected}
            />
          </SectionBoundary>
        </PageBody>
      </AppShell>
    </DrillDownProvider>
  );
}

/**
 * Mounts exactly one container: a page that is not on screen issues no requests.
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
    case 'genui':
      return <GenuiContainer range={range} />;
    case 'pricing':
      return <PricingContainer />;
    // The live feed has no container: its subscription belongs to the shell (see `App`), so this
    // page is the presentational component fed the shell's events.
    case 'live':
      return <LiveSection events={liveEvents} connected={connected} />;
    default:
      return null;
  }
}

/** The SSE connection state, in the topbar on every page. */
function LiveIndicator({ connected }: { connected: boolean }) {
  return (
    <span
      className="hidden items-center gap-1.5 text-[12px] text-dim sm:flex"
      title={connected ? 'Live stream connected' : 'Live stream not connected'}
    >
      <StatusDot tone={connected ? 'good' : 'bad'} className={connected ? 'live-pulse' : ''} />
      live
    </span>
  );
}

/**
 * The UTC day range, behind a popover. A popover rather than a dialog because it is non-modal: the
 * numbers being re-scoped stay readable while the range is being changed.
 */
function RangePicker({
  range,
  onRange,
}: {
  range: GovernanceRange;
  onRange: (range: GovernanceRange) => void;
}) {
  return (
    <Popover>
      <PopoverTrigger render={<Button size="sm" variant="outline" className="mono gap-1.5" />}>
        <CalendarIcon width={12} height={12} />
        <span className="tnum hidden text-fg-2 md:inline">
          {range.fromDay} → {range.toDay}
        </span>
        <span className="sr-only md:hidden">
          {range.fromDay} to {range.toDay}
        </span>
      </PopoverTrigger>
      <PopoverContent className="flex flex-col gap-2">
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
        <p className="text-[10px] text-faint">Whole UTC days, inclusive.</p>
      </PopoverContent>
    </Popover>
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
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is `BareInput`, nested inside.
    <label className="flex items-center justify-between gap-3 rounded-md border border-border bg-panel-2 px-2.5 py-1 text-[11px] text-dim">
      <span className="uppercase tracking-wider">{label}</span>
      <BareInput
        type="date"
        value={value}
        onChange={(event) => {
          const next = event.target.value;
          if (isIsoDay(next)) onChange(next);
        }}
      />
    </label>
  );
}
