import { type ReactNode, useEffect, useState } from 'react';

/** A titled surface with an optional right-aligned control and subtitle. */
export function Panel({
  title,
  subtitle,
  right,
  children,
  className,
}: {
  title?: string;
  subtitle?: string;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel rise p-4 ${className ?? ''}`}>
      {(title || right) && (
        <header className="mb-3 flex items-start justify-between gap-3">
          <div>
            {title && <h2 className="text-sm font-semibold tracking-tight">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-xs text-[var(--muted)]">{subtitle}</p>}
          </div>
          {right}
        </header>
      )}
      {children}
    </section>
  );
}

/** A headline number with a label and optional sub-line. */
export function Stat({
  label,
  value,
  sub,
  icon,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  icon?: ReactNode;
  tone?: 'accent' | 'good' | 'warn' | 'bad';
}) {
  const toneColor =
    tone === 'good'
      ? 'text-[var(--good)]'
      : tone === 'warn'
        ? 'text-[var(--warn)]'
        : tone === 'bad'
          ? 'text-[var(--bad)]'
          : 'text-[var(--text)]';
  return (
    <div className="panel p-4">
      <div className="mb-2 flex items-center gap-2 text-[11px] uppercase tracking-wider text-[var(--muted)]">
        {icon}
        {label}
      </div>
      <div className={`mono tnum text-2xl font-semibold ${toneColor}`}>{value}</div>
      {sub && <div className="mono mt-1 text-[11px] text-[var(--muted)]">{sub}</div>}
    </div>
  );
}

/** A thin progress meter. `ratio` clamps to [0,1] for the fill; `over` recolors an over-budget bar. */
export function BarMeter({
  ratio,
  over,
  className,
}: {
  ratio: number;
  over?: boolean;
  className?: string;
}) {
  const pct = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0)) * 100;
  return (
    <div className={`bar-track h-2 ${className ?? ''}`}>
      <div
        className="bar-fill"
        style={{
          width: `${pct}%`,
          ...(over ? { background: 'linear-gradient(90deg,#f87171,#fbbf24)' } : {}),
        }}
      />
    </div>
  );
}

/** A small pill for a status string, colored by the `.s-*` hues in index.css. */
export function StatusPill({ status }: { status: string }) {
  const normalized = status.toLowerCase();
  const live = normalized === 'running' || normalized === 'pending';
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px]">
      <span className={`dot s-${normalized} ${live ? 'pulse' : ''}`} aria-hidden />
      <span className={`s-${normalized} uppercase tracking-wider`}>{status}</span>
    </span>
  );
}

/**
 * A cell that opens the row's drill-down.
 *
 * Renders as plain text when `onOpen` is absent, which is the honest state for a row that has
 * nothing to open — a tool call recorded before calls carried a run id has no run to show, and a
 * button that does nothing is worse than no button. Same reason it is used in the mock-data preview,
 * where no drill-down provider exists.
 */
export function OpenCell({
  label,
  onOpen,
  title,
}: {
  label: string;
  onOpen?: (() => void) | undefined;
  title?: string;
}) {
  if (onOpen === undefined) {
    return (
      <span className="truncate text-[var(--text)]" title={title ?? label}>
        {label}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      title={title ?? label}
      className="max-w-full truncate text-left text-[var(--text)] underline decoration-[var(--line)] decoration-dotted underline-offset-4 transition-colors hover:decoration-[var(--accent)] hover:text-[var(--accent)]"
    >
      {label}
    </button>
  );
}

/** An empty-state row for a section that has no data yet. */
export function Empty({ label }: { label: string }) {
  return (
    <div className="grid place-items-center rounded-lg border border-dashed border-[var(--line)] py-10 text-xs text-[var(--muted)]">
      {label}
    </div>
  );
}

/** Prev/next pager with "page X of Y" (derived from `total`/`pageSize`) — disables at either bound. */
export function Pagination({
  page,
  pageSize,
  total,
  onPage,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
}) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="mono mt-3 flex items-center justify-end gap-2 text-[11px] text-[var(--muted)]">
      <button
        type="button"
        disabled={page <= 1}
        onClick={() => onPage(page - 1)}
        className="rounded-md border border-[var(--line)] px-2 py-1 transition-colors hover:text-[var(--text)] disabled:opacity-40"
      >
        Prev
      </button>
      <span className="tnum">
        page {page} of {pageCount}
      </span>
      <button
        type="button"
        disabled={page >= pageCount}
        onClick={() => onPage(page + 1)}
        className="rounded-md border border-[var(--line)] px-2 py-1 transition-colors hover:text-[var(--text)] disabled:opacity-40"
      >
        Next
      </button>
    </div>
  );
}

/**
 * A debounced text filter input: the caller only sees `onChange` `delayMs` after typing stops, so a
 * table filter doesn't refetch on every keystroke. Re-syncs its draft when `value` changes externally
 * (e.g. a "clear filters" action).
 */
export function FilterInput({
  value,
  placeholder,
  onChange,
  delayMs = 300,
}: {
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
  delayMs?: number;
}) {
  const [draft, setDraft] = useState(value);

  useEffect(() => setDraft(value), [value]);

  // Only `draft` should re-arm the debounce timer — re-running on `onChange`/`value`/`delayMs`
  // identity would either fire early or loop.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally draft-only, see above.
  useEffect(() => {
    if (draft === value) return;
    const timer = setTimeout(() => onChange(draft), delayMs);
    return () => clearTimeout(timer);
  }, [draft]);

  return (
    <input
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      placeholder={placeholder}
      className="mono w-28 rounded-md border border-[var(--line)] bg-[var(--panel)] px-2 py-1 text-[11px] text-[var(--text)] outline-none placeholder:text-[var(--muted)] focus:border-[var(--accent)]/50"
    />
  );
}

/** A short "Nm ago" relative stamp for an ISO instant or epoch-ms. */
export function relTime(at: string | number): string {
  const ms = typeof at === 'number' ? at : Date.parse(at);
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
