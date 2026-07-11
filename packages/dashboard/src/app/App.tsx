import { type ReactNode, useState } from 'react';
import type {
  ModelPrice,
  SpendOverview,
  ThreadActivityRow,
  ThreadSpendRow,
  ToolCallActivityRow,
  UpsertModelPriceInput,
} from '../client/agent-client';
import { defaultRange, isIsoDay } from '../client/default-range';
import type { FeedEvent } from '../client/merge-live-events';
import { ActorsSection } from './ActorsSection';
import { LiveSection } from './LiveSection';
import { ModelsSection } from './ModelsSection';
import { PricingSection } from './PricingSection';
import { RunsToolsSection } from './RunsToolsSection';
import { SpendSection } from './SpendSection';
import {
  ActivityIcon,
  ChipIcon,
  DollarIcon,
  LogoMark,
  TagIcon,
  UsersIcon,
  WrenchIcon,
} from './icons';
import {
  usePricing,
  useSpend,
  useThreads,
  useToolCalls,
  useTopThreads,
  useUpsertPrice,
} from './use-governance';
import { useLiveEvents } from './use-live-events';

type SectionKey = 'spend' | 'models' | 'actors' | 'runs' | 'pricing' | 'live';

const NAV: { key: SectionKey; label: string; icon: ReactNode }[] = [
  { key: 'spend', label: 'Spend & usage', icon: <DollarIcon /> },
  { key: 'models', label: 'Models', icon: <ChipIcon /> },
  { key: 'actors', label: 'Actors & budgets', icon: <UsersIcon /> },
  { key: 'runs', label: 'Runs & tools', icon: <WrenchIcon /> },
  { key: 'pricing', label: 'Pricing', icon: <TagIcon /> },
  { key: 'live', label: 'Live', icon: <ActivityIcon /> },
];

const EMPTY_SPEND: SpendOverview = { byModel: [], byActor: [], trend: [] };
const EMPTY_TOOL_CALLS: ToolCallActivityRow[] = [];
const EMPTY_THREADS: ThreadActivityRow[] = [];
const EMPTY_TOP_THREADS: ThreadSpendRow[] = [];
const EMPTY_PRICES: ModelPrice[] = [];

/** HTTP status the pricing API 501s with when no `AGENT_PRICING_STORE` is bound. */
const PRICING_UNAVAILABLE_STATUS = '501';

/**
 * The AI-gateway console shell: brand, section nav, a UTC day-range picker, and the live-connection
 * indicator. Data comes from the polling react-query hooks + the SSE live hook; each section is a
 * focused component fed the shaped rows.
 */
export function App() {
  const [range, setRange] = useState(defaultRange());
  const [section, setSection] = useState<SectionKey>('spend');

  const spend = useSpend(range);
  const topThreads = useTopThreads(range);
  const toolCalls = useToolCalls();
  const threads = useThreads();
  const pricing = usePricing();
  const upsertPrice = useUpsertPrice();
  const live = useLiveEvents();

  const overview = spend.data ?? EMPTY_SPEND;
  const pricingUnavailable =
    pricing.isError && pricing.error instanceof Error
      ? pricing.error.message.startsWith(PRICING_UNAVAILABLE_STATUS)
      : false;

  return (
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
          {NAV.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setSection(item.key)}
              className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs transition-colors ${
                section === item.key
                  ? 'border-[var(--accent)]/50 bg-[var(--accent)]/10 text-[var(--text)]'
                  : 'border-transparent text-[var(--muted)] hover:text-[var(--text)]'
              }`}
            >
              {item.icon}
              {item.label}
              {item.key === 'live' && live.events.length > 0 && (
                <span className="mono tnum rounded bg-[var(--accent)]/20 px-1 text-[10px] text-[var(--accent)]">
                  {live.events.length}
                </span>
              )}
            </button>
          ))}
        </nav>

        <ActiveSection
          section={section}
          overview={overview}
          topThreads={topThreads.data ?? EMPTY_TOP_THREADS}
          loadingSpend={spend.isLoading}
          errorSpend={spend.isError}
          toolCalls={toolCalls.data ?? EMPTY_TOOL_CALLS}
          threads={threads.data ?? EMPTY_THREADS}
          liveEvents={live.events}
          connected={live.connected}
          prices={pricing.data ?? EMPTY_PRICES}
          loadingPrices={pricing.isLoading}
          pricingUnavailable={pricingUnavailable}
          onUpsertPrice={(input) => upsertPrice.mutateAsync(input)}
          savingPrice={upsertPrice.isPending}
        />
      </div>
    </div>
  );
}

function ActiveSection({
  section,
  overview,
  topThreads,
  loadingSpend,
  errorSpend,
  toolCalls,
  threads,
  liveEvents,
  connected,
  prices,
  loadingPrices,
  pricingUnavailable,
  onUpsertPrice,
  savingPrice,
}: {
  section: SectionKey;
  overview: SpendOverview;
  topThreads: ThreadSpendRow[];
  loadingSpend: boolean;
  errorSpend: boolean;
  toolCalls: ToolCallActivityRow[];
  threads: ThreadActivityRow[];
  liveEvents: FeedEvent[];
  connected: boolean;
  prices: ModelPrice[];
  loadingPrices: boolean;
  pricingUnavailable: boolean;
  onUpsertPrice: (input: UpsertModelPriceInput) => Promise<void>;
  savingPrice: boolean;
}) {
  if (errorSpend && (section === 'spend' || section === 'models' || section === 'actors')) {
    return (
      <div className="panel p-6 text-sm text-[var(--bad)]">
        Failed to load the read-model. Is the governance read-model bound and the API reachable?
      </div>
    );
  }
  if (loadingSpend && (section === 'spend' || section === 'models' || section === 'actors')) {
    return <div className="panel animate-pulse p-6 text-sm text-[var(--muted)]">Loading…</div>;
  }
  switch (section) {
    case 'spend':
      return <SpendSection overview={overview} topThreads={topThreads} />;
    case 'models':
      return <ModelsSection rows={overview.byModel} />;
    case 'actors':
      return <ActorsSection rows={overview.byActor} />;
    case 'runs':
      return <RunsToolsSection toolCalls={toolCalls} threads={threads} />;
    case 'pricing':
      return (
        <PricingSection
          prices={prices}
          loading={loadingPrices}
          unavailable={pricingUnavailable}
          onUpsert={onUpsertPrice}
          saving={savingPrice}
        />
      );
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
  range: { fromDay: string; toDay: string };
  onRange: (range: { fromDay: string; toDay: string }) => void;
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
